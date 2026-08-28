import { CHUNK_CORPUS } from "./corpus";
import {
  DENSE_MODEL_ID,
  cosine,
  embedMany,
  getDenseProgress,
  isDenseReady,
  loadDense,
  type EmbedBackend,
} from "./embed";
import { detectLang, detectLangFromHistory } from "./lang";
import { composeQueryVector } from "./query-vector";
import { isRerankerReady, rerankScores } from "./rerank";
import type {
  ChatMessage,
  ChunkRecord,
  EngineStatus,
  IndexedChunk,
  Lang,
  MatchHit,
  TraceStep,
} from "./types";

/** Final number of hits shown in the trace */
const TOP_K = 5;
/**
 * Bi-encoder candidates fed into the cross-encoder reranker. The reranker
 * scores one pair at a time, so this also bounds per-turn latency. The
 * recall-oriented bi-encoder keeps the right chunk in this window in practice.
 */
const RERANK_CANDIDATES = 10;
/**
 * Confidence gate: if the best cross-encoder score is below this, treat the
 * turn as "no close match" and gracefully refuse (reply-mode only).
 * With fp32 bge-reranker-base, in-corpus matches score ~0.1–0.99 while clearly
 * out-of-corpus queries top out below ~0.01, so a low threshold separates them.
 */
const RERANK_MIN_SCORE = 0.03;

export class ChunkKVEngine {
  private index: IndexedChunk[] = [];
  private backend: EmbedBackend = "hash";
  private usedIds = new Set<string>();
  private initPromise: Promise<void> | null = null;

  get status(): EngineStatus {
    if (this.index.length === 0) {
      return { kind: "booting", detail: getDenseProgress() || "起動中" };
    }
    return {
      kind: "ready",
      backend: this.backend,
      chunkCount: this.index.length,
    };
  }

  get corpus(): ChunkRecord[] {
    return CHUNK_CORPUS;
  }

  get modelId(): string {
    return this.backend === "dense" ? DENSE_MODEL_ID : "hash-ngram-384";
  }

  /** Instant hash index so the UI can talk while the dense model downloads */
  async ensureHash(): Promise<void> {
    if (this.index.length > 0 && this.backend === "hash") return;
    if (this.index.length > 0 && this.backend === "dense") return;

    this.backend = "hash";
    const vectors = await embedMany(
      CHUNK_CORPUS.map((c) => c.key),
      "hash",
    );
    this.index = CHUNK_CORPUS.map((c, i) => ({
      ...c,
      embedding: vectors[i],
    }));
  }

  /** Load the multilingual dense model and rebuild the chunk KV index */
  async ensureDense(
    onProgress?: (msg: string) => void,
  ): Promise<{ upgraded: boolean }> {
    if (this.backend === "dense" && isDenseReady() && this.index.length > 0) {
      return { upgraded: false };
    }

    if (!this.initPromise) {
      this.initPromise = (async () => {
        await loadDense(onProgress);
        onProgress?.("チャンクキーを埋め込み中…");
        const vectors = await embedMany(
          CHUNK_CORPUS.map((c) => c.key),
          "dense",
          (done, total) => onProgress?.(`チャンク ${done}/${total}`),
        );
        this.backend = "dense";
        this.index = CHUNK_CORPUS.map((c, i) => ({
          ...c,
          embedding: vectors[i],
        }));
        this.usedIds.clear();
        onProgress?.("多言語インデックス完了");
      })().finally(() => {
        this.initPromise = null;
      });
    }

    await this.initPromise;
    return { upgraded: true };
  }

  resetMemory(): void {
    this.usedIds.clear();
  }

  private search(
    queryVec: Float32Array,
    preferSpeaker?: "user" | "bot",
    lang?: Lang,
    limit: number = TOP_K,
  ): MatchHit[] {
    const scored: MatchHit[] = [];
    for (const chunk of this.index) {
      // Hard filter: bot replies must come from bot values, user predictions from user values
      if (preferSpeaker && chunk.speaker !== preferSpeaker) continue;
      // Hard filter: reply in the same language as the query
      if (lang && chunk.lang !== lang) continue;
      let score = cosine(queryVec, chunk.embedding);
      if (this.usedIds.has(chunk.id)) score -= 0.12;
      scored.push({
        chunk: {
          id: chunk.id,
          key: chunk.key,
          value: chunk.value,
          speaker: chunk.speaker,
          lang: chunk.lang,
          claim: chunk.claim,
          tags: chunk.tags,
        },
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Stage 2: re-score bi-encoder candidates with the cross-encoder against the
   * chunk key (trigger context), apply the reuse penalty, and re-sort.
   * Returns the reordered hits (already sliced to TOP_K).
   */
  private async rerank(
    query: string,
    candidates: MatchHit[],
  ): Promise<MatchHit[]> {
    // Rerank on the raw cross-encoder score. Anti-repetition is already handled
    // in the bi-encoder candidate selection (usedIds penalty); applying another
    // penalty here would wipe out valid low-scoring matches and trip the
    // confidence gate into false refusals.
    const scores = await rerankScores(
      query,
      candidates.map((h) => h.chunk.key),
    );
    const reranked = candidates.map((h, i) => ({ ...h, rerankScore: scores[i] }));
    reranked.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
    return reranked.slice(0, TOP_K);
  }

  /** The graceful "no close match" chunk for a language (reply-mode refusal). */
  private refusalChunk(lang: Lang): ChunkRecord | undefined {
    return (
      this.index.find((c) => c.claim === "limit-1" && c.lang === lang) ??
      this.index.find((c) => c.claim === "limit-3" && c.lang === lang)
    );
  }

  async predictNext(
    history: ChatMessage[],
    latestUser: string | undefined,
    preferSpeaker: "user" | "bot",
  ): Promise<{ message: ChatMessage; trace: TraceStep }> {
    if (this.index.length === 0) {
      await this.ensureHash();
    }

    const t0 = performance.now();
    const queryLang = latestUser?.trim()
      ? detectLang(latestUser)
      : detectLangFromHistory(history);
    const composed = await composeQueryVector(
      history,
      latestUser,
      this.backend,
    );

    // Stage 1: bi-encoder retrieval. Pull a wider candidate set when the
    // reranker is available so stage 2 has room to reorder.
    const useReranker = isRerankerReady();
    const candidateK = useReranker ? RERANK_CANDIDATES : TOP_K;
    let candidates = this.search(
      composed.vector,
      preferSpeaker,
      queryLang,
      candidateK,
    );
    // Fallback: if the corpus has nothing in the detected language, drop the
    // language filter rather than returning nothing.
    if (candidates.length === 0) {
      candidates = this.search(composed.vector, preferSpeaker, undefined, candidateK);
    }

    // Stage 2: cross-encoder rerank against the chunk key (trigger context).
    const rerankQuery = composed.anchorText || latestUser?.trim() || "";
    let hits = candidates;
    let reranked = false;
    if (useReranker && candidates.length > 0 && rerankQuery) {
      try {
        hits = await this.rerank(rerankQuery, candidates);
        reranked = true;
      } catch {
        hits = candidates.slice(0, TOP_K);
      }
    } else {
      hits = candidates.slice(0, TOP_K);
    }

    let chosen = hits[0];
    if (!chosen) throw new Error("チャンクが空です");

    // Confidence gate (reply-mode only): if the best cross-encoder score is
    // below threshold, nothing in the corpus is a close match — refuse
    // gracefully with the language's "no close key" chunk instead of pasting
    // an off-target reply.
    const topRerankScore = reranked ? chosen.rerankScore : undefined;
    let lowConfidence = false;
    if (
      reranked &&
      preferSpeaker === "bot" &&
      (topRerankScore ?? 0) < RERANK_MIN_SCORE
    ) {
      const refusal = this.refusalChunk(queryLang);
      if (refusal) {
        lowConfidence = true;
        chosen = {
          chunk: {
            id: refusal.id,
            key: refusal.key,
            value: refusal.value,
            speaker: refusal.speaker,
            lang: refusal.lang,
            claim: refusal.claim,
            tags: refusal.tags,
          },
          score: chosen.score,
          rerankScore: chosen.rerankScore,
        };
      }
    }

    this.usedIds.add(chosen.chunk.id);
    if (this.usedIds.size > 24) {
      this.usedIds = new Set([...this.usedIds].slice(-12));
    }

    const queryText = composed.summary;

    return {
      message: {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: chosen.chunk.speaker,
        text: chosen.chunk.value,
        sourceChunkId: chosen.chunk.id,
        score: chosen.score,
      },
      trace: {
        queryLang,
        reranked,
        topRerankScore,
        lowConfidence,
        queryText,
        querySummary: composed.summary,
        queryTurns: composed.turns.map((t) => ({
          role: t.role,
          text: t.text,
          age: t.age,
          finalWeight: t.finalWeight,
          anchorSimilarity: t.anchorSimilarity,
          included: t.included,
          pairIndex: t.pairIndex,
        })),
        queryPairs: composed.pairs.map((p) => ({
          index: p.index,
          userText: p.userText,
          botText: p.botText,
          anchorSimilarity: p.anchorSimilarity,
          chainSimilarity: p.chainSimilarity,
          included: p.included,
          finalWeight: p.finalWeight,
        })),
        hits,
        chosen,
        latencyMs: Math.round(performance.now() - t0),
      },
    };
  }

  async reply(history: ChatMessage[], userText: string) {
    return this.predictNext(history, userText, "bot");
  }

  async predictUser(history: ChatMessage[]) {
    return this.predictNext(history, undefined, "user");
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __notalmEngine: ChunkKVEngine | undefined;
}

export function getEngine(): ChunkKVEngine {
  if (!globalThis.__notalmEngine) {
    globalThis.__notalmEngine = new ChunkKVEngine();
  }
  return globalThis.__notalmEngine;
}
