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
import type {
  ChatMessage,
  ChunkRecord,
  EngineStatus,
  IndexedChunk,
  Lang,
  MatchHit,
  TraceStep,
} from "./types";

const TOP_K = 5;

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
    return scored.slice(0, TOP_K);
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
    let hits = this.search(composed.vector, preferSpeaker, queryLang);
    // Fallback: if the corpus has nothing in the detected language, drop the
    // language filter rather than returning nothing.
    if (hits.length === 0) {
      hits = this.search(composed.vector, preferSpeaker);
    }
    const chosen = hits[0];
    if (!chosen) throw new Error("チャンクが空です");

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
