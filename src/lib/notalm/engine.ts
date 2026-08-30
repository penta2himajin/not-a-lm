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
import { isNliReady, nliClassify } from "./nli";
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
 * How many bi-encoder top candidates the confidence gate re-checks with the
 * cross-encoder. Ranking is done by the bi-encoder alone (over natural keys);
 * the reranker is used only to gate, so we score a few top candidates' keyword
 * keys and take the max as the confidence.
 */
const GATE_CANDIDATES = 3;
/**
 * Confidence gate: if the best cross-encoder score (over the top candidates'
 * keyword keys) is below this, treat the turn as "no close match" and refuse
 * gracefully (reply-mode only). Keyword keys separate in-corpus (~0.1–0.99)
 * from out-of-corpus (~0) far better than natural keys do.
 */
const GATE_MIN_SCORE = 0.03;
/**
 * Cosine "rescue" against reranker false-refusals: if the gate would refuse but
 * the ranking top-1's raw bi-encoder cosine is at least this high, the nearest
 * corpus element is a clear match and the low reranker score was a fluke —
 * answer instead of refusing. Used ONE-WAY only (refuse → answer); never to
 * detect OOC (bi-encoder cosine separates in/out poorly; see the docs). Set
 * high enough to sit above the OOC "overlap band".
 */
const RESCUE_COS = 0.7;
/** Min NLI entailment probability to treat a query as presupposing the assertion */
const NLI_ENTAIL_MIN = 0.5;
/**
 * Fusion: if the top two candidates are BOTH strongly relevant (gate score) and
 * cover different topics, combine them into one reply with a closed connective.
 * High threshold so fusion only fires for genuinely compound/broad questions.
 */
const FUSE_MIN = 0.5;
/** Closed-set additive connective per language for fusion (glue, not generated). */
const FUSE_CONNECTIVE: Record<Lang, string> = {
  ja: "ちなみに、",
  en: " Also, ",
  zh: "另外，",
};
/**
 * Closed-set negation openers per language for grounded generation. The reply is
 * this opener + the chunk's own (copied) value — no token generation.
 */
const NEGATION_OPENER: Record<Lang, string> = {
  ja: "いいえ、そうではありません。",
  en: "No, that's not the case. ",
  zh: "不，并不是这样。",
};
/** Closed-set affirmation openers (for a true presupposition, stance = affirm). */
const AFFIRM_OPENER: Record<Lang, string> = {
  ja: "はい、その通りです。",
  en: "Yes, exactly. ",
  zh: "对，正是如此。",
};

/**
 * Light normalization of the user question before NLI: strip trailing
 * punctuation so a question reads a bit more like a statement (NLI premises are
 * declarative). No token generation — this only trims the NLI input, not the
 * reply.
 */
function normalizeForNli(q: string): string {
  return q.trim().replace(/[？?！!。．.、,\s]+$/u, "");
}

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
      CHUNK_CORPUS.map((c) => c.natKey),
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
          CHUNK_CORPUS.map((c) => c.natKey),
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
          natKey: chunk.natKey,
          value: chunk.value,
          speaker: chunk.speaker,
          lang: chunk.lang,
          claim: chunk.claim,
          assertions: chunk.assertions,
          stance: chunk.stance,
          tags: chunk.tags,
        },
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Stage 2 (gate only): score the top bi-encoder candidates' KEYWORD keys with
   * the cross-encoder and return the max as a confidence signal. Ranking is not
   * changed — the bi-encoder over natural keys already ranks best (the reranker
   * does not improve ranking on this corpus); the cross-encoder is used only to
   * decide whether anything is a close enough match. Also annotates each scored
   * hit with its rerankScore for the trace.
   */
  private async gateConfidence(
    query: string,
    hits: MatchHit[],
  ): Promise<number> {
    const top = hits.slice(0, GATE_CANDIDATES);
    const scores = await rerankScores(
      query,
      top.map((h) => h.chunk.key),
    );
    top.forEach((h, i) => (h.rerankScore = scores[i]));
    return scores.length ? Math.max(...scores) : 0;
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
    opts: { generate?: boolean } = {},
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

    // Stage 1 (ranking): bi-encoder over natural keys. This alone ranks best on
    // this corpus; the cross-encoder does not improve ranking, so it is NOT used
    // to reorder — only to gate (below).
    let hits = this.search(composed.vector, preferSpeaker, queryLang, TOP_K);
    // Fallback: if the corpus has nothing in the detected language, drop the
    // language filter rather than returning nothing.
    if (hits.length === 0) {
      hits = this.search(composed.vector, preferSpeaker, undefined, TOP_K);
    }

    let chosen = hits[0];
    if (!chosen) throw new Error("チャンクが空です");

    // Raw bi-encoder cosine of the ranking top-1 (no reuse penalty) — the
    // "how close is the nearest corpus element" signal, used only to rescue
    // reranker false-refusals below.
    const topEntry = this.index.find((c) => c.id === chosen.chunk.id);
    const topCosine = topEntry
      ? cosine(composed.vector, topEntry.embedding)
      : 0;

    // Stage 2 (gate only): score the top candidates' KEYWORD keys with the
    // cross-encoder. Keyword keys separate in-corpus vs out-of-corpus far better
    // than natural keys, so this is a reliable confidence signal.
    const gateQuery = composed.anchorText || latestUser?.trim() || "";
    let gated = false;
    let topRerankScore: number | undefined;
    let lowConfidence = false;
    let rescued = false;
    if (isRerankerReady() && gateQuery && preferSpeaker === "bot") {
      try {
        topRerankScore = await this.gateConfidence(gateQuery, hits);
        gated = true;
      } catch {
        /* gate unavailable: fall through without refusing */
      }
    }

    // Confidence gate (reply-mode only): if the best keyword-key score is below
    // threshold, nothing in the corpus is a close match — refuse gracefully with
    // the language's "no close key" chunk. One-way cosine rescue: if the nearest
    // corpus element is very close (topCosine >= RESCUE_COS), the low reranker
    // score is likely a fluke, so answer instead of refusing.
    if (gated && (topRerankScore ?? 0) < GATE_MIN_SCORE && topCosine >= RESCUE_COS) {
      rescued = true;
    }
    if (gated && (topRerankScore ?? 0) < GATE_MIN_SCORE && !rescued) {
      const refusal = this.refusalChunk(queryLang);
      if (refusal) {
        lowConfidence = true;
        chosen = {
          chunk: {
            id: refusal.id,
            key: refusal.key,
            natKey: refusal.natKey,
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

    // Stage 3 (grounded generation, reply-mode + opt-in): if the chosen chunk is
    // polarizable and the user's question presupposes its assertion (NLI
    // entailment) while the chunk denies it, the presupposition is false —
    // compose a correction = closed negation opener + the chunk's own value
    // (copied, no token generation). Otherwise return the value as-is.
    let replyText = chosen.chunk.value;
    let generated = false;
    let operation:
      | "as-is"
      | "negate-correct"
      | "affirm-confirm"
      | "fuse"
      | undefined;
    let nliLabel: string | undefined;
    let nliScore: number | undefined;
    if (
      opts.generate &&
      preferSpeaker === "bot" &&
      !lowConfidence &&
      isNliReady() &&
      gateQuery &&
      chosen.chunk.assertions?.length &&
      chosen.chunk.stance
    ) {
      try {
        const premise = normalizeForNli(gateQuery);
        // NLI against each assertion phrasing; take the strongest entailment.
        let bestEntail = -1;
        let bestLabel = "neutral";
        for (const assertion of chosen.chunk.assertions) {
          const nli = await nliClassify(premise, assertion);
          if (nli.entail > bestEntail) {
            bestEntail = nli.entail;
            bestLabel = nli.label;
          }
        }
        nliLabel = bestLabel;
        nliScore = bestEntail;
        operation = "as-is";
        if (bestEntail >= NLI_ENTAIL_MIN) {
          if (chosen.chunk.stance === "deny") {
            operation = "negate-correct";
            generated = true;
            replyText =
              NEGATION_OPENER[chosen.chunk.lang] + chosen.chunk.value;
          } else if (chosen.chunk.stance === "affirm") {
            operation = "affirm-confirm";
            generated = true;
            replyText = AFFIRM_OPENER[chosen.chunk.lang] + chosen.chunk.value;
          }
        }
      } catch {
        /* NLI unavailable: fall through with the as-is value */
      }
    }

    // Stage 3b — fusion: if no polarity op fired and the top two candidates are
    // both strongly relevant (gate score) but cover different topics, combine
    // them into one reply with a closed connective (both values copied, only the
    // connective is glue — no token generation).
    let fusedWith: string | undefined;
    if (
      opts.generate &&
      preferSpeaker === "bot" &&
      !lowConfidence &&
      !generated &&
      isRerankerReady() &&
      hits.length >= 2
    ) {
      const s0 = hits[0].rerankScore;
      const s1 = hits[1].rerankScore;
      if (
        s0 != null &&
        s1 != null &&
        s0 >= FUSE_MIN &&
        s1 >= FUSE_MIN &&
        hits[0].chunk.claim !== hits[1].chunk.claim &&
        hits[0].chunk.tags[0] !== hits[1].chunk.tags[0]
      ) {
        operation = "fuse";
        generated = true;
        fusedWith = hits[1].chunk.id;
        replyText =
          hits[0].chunk.value +
          FUSE_CONNECTIVE[chosen.chunk.lang] +
          hits[1].chunk.value;
      }
    }

    const queryText = composed.summary;

    return {
      message: {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: chosen.chunk.speaker,
        text: replyText,
        sourceChunkId: chosen.chunk.id,
        score: chosen.score,
      },
      trace: {
        queryLang,
        generated,
        operation,
        fusedWith,
        nliLabel,
        nliScore,
        reranked: gated,
        topRerankScore,
        topCosine,
        rescued,
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

  async reply(
    history: ChatMessage[],
    userText: string,
    opts: { generate?: boolean } = {},
  ) {
    return this.predictNext(history, userText, "bot", opts);
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
