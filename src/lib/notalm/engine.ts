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
import {
  createCeScorer,
  isRerankerReady,
  type CeScorer,
} from "./rerank";
import {
  buildChainDemoPlan,
  findChunkByClaim,
} from "./chain-plan";
import {
  buildTurnGrounding,
  classifyAnaphora,
  continuityFromPrior,
  injectProximal,
  lastBotGrounding,
  planClarifyRecent,
  recentBotGroundings,
  adjustScoreForContinuity,
  type AnaphoraClass,
  type ContinuityHint,
} from "./grounding";
import {
  GROUNDED_OPENERS,
  deriveOperationLabel,
  fusePartsFromMatched,
  fusedComposeFromPlan,
  fusedWithFromPlan,
  peekPolarity,
  planFuseParts,
  planSignals,
  planSingleChunk,
  primaryComposePlan,
  renderOperationPlan,
  selectBestPlan,
} from "./plan";
import {
  buildSpanIndexManifest,
  KEY_POOL,
  mergeDualRetrieval,
  searchSpanIndex,
  SPAN_AUTHOR_MIN_COS,
  type SpanIndexEntry,
} from "./span-index";
import type {
  ChatMessage,
  ChunkRecord,
  ComposePlan,
  EngineStatus,
  FusePartTrace,
  IndexedChunk,
  Lang,
  MatchHit,
  OperationPlan,
  PlanCandidate,
  TraceStep,
} from "./types";

/** G6d audit blob attached to a turn executed from a ChainPlan. */
export type ChainTraceMeta = NonNullable<TraceStep["chain"]>;

type PredictOpts = {
  generate?: boolean;
  chain?: ChainTraceMeta;
};

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
/**
 * Compound + generate: run fuse before the gate when bi-encoder top-1 cosine is
 * at least this high. Successful fuse (≥2 parts @ FUSE_MIN) skips gate CE.
 */
const COMPOUND_FUSE_FIRST_MIN_COS = 0.62;
/**
 * Do not run compound fuse CE when top cosine is below this (OOC compound saves
 * S×KEY_POOL forwards; gate still runs).
 */
const FUSE_COMPOUND_MIN_COS = 0.62;
/**
 * Fusion: if the top two candidates are BOTH strongly relevant (gate score) and
 * cover different topics, combine them into one reply with a closed connective.
 * High threshold so fusion only fires for genuinely compound/broad questions.
 */
const FUSE_MIN = 0.5;
/** Split a compound query into segments on conjunction markers. */
function segmentQuery(text: string, lang: Lang): string[] {
  const sep =
    lang === "en"
      ? /\s+and\s+|,/i
      : /[、，]|と|や|および|また|和|与|以及|还有/;
  return text
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Trim trailing request phrases/particles so an extracted segment reads as a topic. */
function cleanSegment(seg: string, lang: Lang): string {
  let s = seg.trim();
  if (lang === "ja") {
    s = s
      .replace(/(を)?(教えて|おしえて)$/u, "")
      .replace(/について$/u, "")
      .replace(/[はをのとや、。．？！\s]+$/u, "");
  } else if (lang === "zh") {
    s = s.replace(/(是什么|呢|吗)?[？。！，、\s]*$/u, "");
  } else {
    s = s
      .replace(/^(tell me about|what about|and)\s+/i, "")
      .replace(/[?.!\s]+$/u, "");
  }
  return s.trim();
}

/**
 * Fluent topic connector / stripLeadingFiller / polarity openers live in plan.ts
 * (G5 renderer). Engine only segments queries for fusion matching.
 */
export class ChunkKVEngine {
  private index: IndexedChunk[] = [];
  private spanIndex: SpanIndexEntry[] = [];
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
    await this.rebuildSpanIndex("hash");
  }

  private async rebuildSpanIndex(backend: EmbedBackend): Promise<void> {
    const manifest = buildSpanIndexManifest(CHUNK_CORPUS);
    if (manifest.length === 0) {
      this.spanIndex = [];
      return;
    }
    const vectors = await embedMany(
      manifest.map((m) => m.text),
      backend,
    );
    this.spanIndex = manifest.map((m, i) => ({
      ...m,
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
        onProgress?.("スパン索引を埋め込み中…");
        await this.rebuildSpanIndex("dense");
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
    continuity?: ContinuityHint,
  ): MatchHit[] {
    const scored: MatchHit[] = [];
    for (const chunk of this.index) {
      // Hard filter: bot replies must come from bot values, user predictions from user values
      if (preferSpeaker && chunk.speaker !== preferSpeaker) continue;
      // Hard filter: reply in the same language as the query
      if (lang && chunk.lang !== lang) continue;
      const raw = cosine(queryVec, chunk.embedding);
      const { score } = adjustScoreForContinuity(
        raw,
        chunk,
        this.usedIds,
        continuity,
      );
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
          spans: chunk.spans,
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
    keyHits: MatchHit[],
    ce: CeScorer,
    chosen?: MatchHit,
  ): Promise<number> {
    const top = keyHits.slice(0, GATE_CANDIDATES);
    const candidates = [...top];
    if (
      chosen &&
      !candidates.some((h) => h.chunk.id === chosen.chunk.id)
    ) {
      candidates.push(chosen);
    }
    const scores = await ce.score(
      query,
      candidates.map((h) => h.chunk.key),
    );
    candidates.forEach((h, i) => (h.rerankScore = scores[i]));
    top.forEach((h) => {
      const idx = candidates.findIndex((c) => c.chunk.id === h.chunk.id);
      if (idx >= 0) h.rerankScore = scores[idx];
    });
    return scores.length ? Math.max(...scores) : 0;
  }

  /** Number of distinct meaningful segments in a (possibly compound) query. */
  private compoundSegments(query: string, lang: Lang): string[] {
    return [
      ...new Set(
        segmentQuery(query, lang)
          .map((s) => cleanSegment(s, lang))
          .filter((s) => s.length >= 2),
      ),
    ];
  }

  /**
   * Fusion matching: segment → distinct chunks. Returns OperationPlan via
   * planFuseParts (G5), or null if fusion should not fire.
   * Also returns per-part rerank scores for G5d plan scoring.
   */
  private async fuseCompound(
    query: string,
    queryVec: Float32Array,
    lang: Lang,
    ce: CeScorer,
    continuity?: ContinuityHint,
  ): Promise<{
    plan: OperationPlan;
    parts: { seg: string; chunk: ChunkRecord; score: number }[];
    nliLabel?: string;
    nliScore?: number;
  } | null> {
    const segments = this.compoundSegments(query, lang);
    if (segments.length < 2) return null;

    const cands = this.search(queryVec, "bot", lang, KEY_POOL, continuity);
    if (cands.length < 2) return null;

    const rr: number[][] = [];
    for (let i = 0; i < segments.length; i++) {
      rr.push(await ce.score(segments[i], cands.map((c) => c.chunk.key)));
    }
    const pairs: { i: number; j: number; s: number }[] = [];
    for (let i = 0; i < segments.length; i++) {
      for (let j = 0; j < cands.length; j++) pairs.push({ i, j, s: rr[i][j] });
    }
    pairs.sort((a, b) => b.s - a.s);
    const usedSeg = new Set<number>();
    const usedCand = new Set<number>();
    const assign = new Map<number, number>();
    const assignScore = new Map<number, number>();
    for (const p of pairs) {
      if (p.s < FUSE_MIN) break;
      if (usedSeg.has(p.i) || usedCand.has(p.j)) continue;
      assign.set(p.i, p.j);
      assignScore.set(p.i, p.s);
      usedSeg.add(p.i);
      usedCand.add(p.j);
    }

    const parts: { seg: string; chunk: ChunkRecord; score: number }[] = [];
    for (let i = 0; i < segments.length; i++) {
      const j = assign.get(i);
      if (j == null) continue;
      parts.push({
        seg: segments[i],
        chunk: cands[j].chunk,
        score: assignScore.get(i) ?? 0,
      });
    }
    if (parts.length < 2) return null;

    const planned = await planFuseParts(parts, lang);
    if (!planned) return null;
    return { plan: planned.plan, parts, nliLabel: planned.nliLabel, nliScore: planned.nliScore };
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
    opts: PredictOpts = {},
  ): Promise<{ message: ChatMessage; trace: TraceStep }> {
    if (this.index.length === 0) {
      await this.ensureHash();
    }

    const t0 = performance.now();
    const queryLang = latestUser?.trim()
      ? detectLang(latestUser)
      : detectLangFromHistory(history);
    const rawUser = latestUser?.trim() || "";
    const priorGroundingEarly = lastBotGrounding(history);
    const recentGroundings = recentBotGroundings(history, 3);
    let anaphora: AnaphoraClass = rawUser
      ? classifyAnaphora(rawUser, queryLang)
      : "none";

    // G6b: 「さっきの」with only one prior bot turn → treat as proximal.
    if (anaphora === "non-proximal" && recentGroundings.length <= 1) {
      anaphora = recentGroundings.length === 1 ? "proximal" : "none";
    }

    // G6c: stick to prior chunk/claim despite usedIds (bot replies only).
    const continuity: ContinuityHint | undefined =
      preferSpeaker === "bot"
        ? continuityFromPrior(priorGroundingEarly)
        : undefined;

    // G6b-proximal: expand planning/retrieval anchor with prior excerpt copy.
    let planningUser = rawUser;
    const g6bReasons: string[] = [];
    if (
      anaphora === "proximal" &&
      priorGroundingEarly &&
      opts.generate &&
      preferSpeaker === "bot"
    ) {
      const inj = injectProximal(rawUser, priorGroundingEarly);
      planningUser = inj.effectiveQuery;
      g6bReasons.push(...inj.reasons);
    }

    const composed = await composeQueryVector(
      history,
      planningUser || latestUser,
      this.backend,
    );

    // G6b-clarify: short-circuit before retrieve/gate (avoid OOC refuse on さっきの).
    if (
      opts.generate &&
      preferSpeaker === "bot" &&
      anaphora === "non-proximal" &&
      recentGroundings.length >= 2
    ) {
      const clarifyPlan = planClarifyRecent(recentGroundings, queryLang);
      const replyText = renderOperationPlan(
        clarifyPlan,
        () => undefined,
        queryLang,
        GROUNDED_OPENERS,
      );
      const anchorChunk =
        this.index.find((c) => c.id === recentGroundings[0].chunkId) ??
        this.refusalChunk(queryLang);
      if (!anchorChunk) throw new Error("チャンクが空です");
      const hit: MatchHit = {
        chunk: {
          id: anchorChunk.id,
          key: anchorChunk.key,
          natKey: anchorChunk.natKey,
          value: anchorChunk.value,
          speaker: anchorChunk.speaker,
          lang: anchorChunk.lang,
          claim: anchorChunk.claim,
          tags: anchorChunk.tags,
        },
        score: 1,
      };
      const turnGrounding = buildTurnGrounding({
        chunk: anchorChunk,
        operation: "clarify",
        excerptTextsOverride: recentGroundings.flatMap((g) =>
          g.excerptTexts.slice(0, 1),
        ),
      });
      return {
        message: {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          role: "bot",
          text: replyText,
          sourceChunkId: anchorChunk.id,
          score: 1,
          grounding: turnGrounding,
        },
        trace: {
          queryLang,
          anaphora,
          priorGrounding: priorGroundingEarly,
          turnGrounding,
          chain: opts.chain,
          generated: true,
          operation: "clarify",
          operationPlan: clarifyPlan,
          queryText: composed.summary,
          querySummary: composed.summary,
          hits: [hit],
          chosen: hit,
          latencyMs: Math.round(performance.now() - t0),
        },
      };
    }

    // Stage 1 (ranking): bi-encoder over natural keys (+ dual-index span merge).
    const searchLimit = this.spanIndex.length > 0 ? KEY_POOL : TOP_K;
    let hits = this.search(
      composed.vector,
      preferSpeaker,
      queryLang,
      searchLimit,
      continuity,
    );
    // Fallback: if the corpus has nothing in the detected language, drop the
    // language filter rather than returning nothing.
    if (hits.length === 0) {
      hits = this.search(
        composed.vector,
        preferSpeaker,
        undefined,
        searchLimit,
        continuity,
      );
    }

    const keyHitsForGate = hits.map((h) => ({ ...h }));

    let retrievalSource: "natKey" | "span" = "natKey";
    let matchedSpanId: string | undefined;
    let matchedSpanKind: "author" | "key-span" | undefined;
    let matchedSpanText: string | undefined;
    let spanScore: number | undefined;

    if (this.spanIndex.length > 0 && preferSpeaker === "bot") {
      const chunkById = new Map(this.index.map((c) => [c.id, c]));
      const spanHits = searchSpanIndex(
        composed.vector,
        this.spanIndex,
        chunkById,
        queryLang,
      );
      const gateQueryEarly = composed.anchorText || latestUser?.trim() || "";
      const dual = mergeDualRetrieval(
        composed.vector,
        hits,
        spanHits,
        chunkById,
        this.usedIds,
        gateQueryEarly,
        continuity,
      );
      hits = dual.hits;
      retrievalSource = dual.retrievalSource;
      matchedSpanId = dual.matchedSpanId;
      matchedSpanKind = dual.matchedSpanKind;
      matchedSpanText = dual.matchedSpanText;
      spanScore = dual.spanScore;
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
    // G6b: use planningUser (proximal-injected) when present.
    const gateQuery =
      planningUser || composed.anchorText || rawUser || "";
    const compoundSegs =
      preferSpeaker === "bot"
        ? this.compoundSegments(gateQuery, queryLang)
        : [];
    let gated = false;
    let gateFromFuse = false;
    let topRerankScore: number | undefined;
    let lowConfidence = false;
    let rescued = false;
    const spanGateBypass =
      retrievalSource === "span" &&
      matchedSpanKind === "author" &&
      (spanScore ?? 0) >= SPAN_AUTHOR_MIN_COS;

    const ce = createCeScorer();
    let precomputedFuse: Awaited<
      ReturnType<ChunkKVEngine["fuseCompound"]>
    > = null;
    const tryFuseFirst =
      opts.generate &&
      preferSpeaker === "bot" &&
      compoundSegs.length >= 2 &&
      topCosine >= COMPOUND_FUSE_FIRST_MIN_COS;

    if (isRerankerReady() && tryFuseFirst) {
      try {
        precomputedFuse = await this.fuseCompound(
          gateQuery,
          composed.vector,
          queryLang,
          ce,
          continuity,
        );
      } catch {
        precomputedFuse = null;
      }
    }

    if (isRerankerReady() && gateQuery && preferSpeaker === "bot") {
      try {
        if (precomputedFuse && precomputedFuse.parts.length >= 2) {
          topRerankScore = Math.max(...precomputedFuse.parts.map((p) => p.score));
          gated = true;
          gateFromFuse = true;
        } else {
          // Gate on pre-merge key pool + merged winner (span rescue may sit outside key top-K).
          topRerankScore = await this.gateConfidence(
            gateQuery,
            keyHitsForGate,
            ce,
            chosen,
          );
          gated = true;
        }
      } catch {
        /* gate unavailable: fall through without refusing */
      }
    }

    // Confidence gate (reply-mode only): if the best keyword-key score is below
    // threshold, nothing in the corpus is a close match — refuse gracefully with
    // the language's "no close key" chunk. One-way cosine rescue: if the nearest
    // corpus element is very close (topCosine >= RESCUE_COS), the low reranker
    // score is likely a fluke, so answer instead of refusing. Span author rescue
    // bypass: strong span match already validated the parent chunk.
    if (gated && (topRerankScore ?? 0) < GATE_MIN_SCORE && topCosine >= RESCUE_COS) {
      rescued = true;
    }
    if (
      gated &&
      (topRerankScore ?? 0) < GATE_MIN_SCORE &&
      !rescued &&
      !spanGateBypass
    ) {
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

    // Stage 3–4 (G5): build candidate OperationPlans, G5d-score, then render.
    // G5c: fuse still gets per-segment polarity inside planFuseParts.
    // G5d: fuse is no longer auto-preferred — score vs single and pick.
    let replyText = chosen.chunk.value;
    let generated = false;
    let operation:
      | "as-is"
      | "negate-correct"
      | "affirm-confirm"
      | "fuse"
      | "compose"
      | "clarify"
      | undefined;
    let composePlan: ComposePlan | undefined;
    let operationPlan: OperationPlan | undefined;
    let nliLabel: string | undefined;
    let nliScore: number | undefined;
    let fusedWith: string | undefined;
    let fuseParts: FusePartTrace[] | undefined;
    let fusedCompose: boolean | undefined;

    if (opts.generate && preferSpeaker === "bot" && !lowConfidence) {
      const chunkById = new Map(this.index.map((c) => [c.id, c]));
      const getChunk = (id: string) => chunkById.get(id);

      const polarity = await peekPolarity(gateQuery, chosen.chunk);
      nliLabel = polarity.nliLabel;
      nliScore = polarity.nliScore;

      const candidates: PlanCandidate[] = [];
      let fusedMeta: {
        parts: { seg: string; chunk: ChunkRecord; score: number }[];
        nliLabel?: string;
        nliScore?: number;
      } | null = null;

      if (
        isRerankerReady() &&
        compoundSegs.length >= 2 &&
        topCosine >= FUSE_COMPOUND_MIN_COS
      ) {
        const fused = tryFuseFirst
          ? precomputedFuse
          : await this.fuseCompound(
              gateQuery,
              composed.vector,
              chosen.chunk.lang,
              ce,
              continuity,
            );
        if (fused) {
          const meanRel =
            fused.parts.reduce((a, p) => a + p.score, 0) / fused.parts.length;
          candidates.push({
            id: "fuse",
            plan: fused.plan,
            signals: planSignals(fused.plan, {
              relevance: meanRel,
              nliEntail: fused.nliScore,
            }),
          });
          fusedMeta = {
            parts: fused.parts,
            nliLabel: fused.nliLabel,
            nliScore: fused.nliScore,
          };
        }
      }

      const proximalFocus =
        anaphora === "proximal" &&
        priorGroundingEarly &&
        priorGroundingEarly.chunkId === chosen.chunk.id
          ? priorGroundingEarly.kept?.[0]
          : undefined;

      const single = await planSingleChunk({
        query: gateQuery,
        chunk: chosen.chunk,
        lang: chosen.chunk.lang,
        focusSpanId:
          proximalFocus?.spanId ??
          (retrievalSource === "span" && matchedSpanKind === "author"
            ? matchedSpanId
            : undefined),
        focusKeySpanText:
          anaphora === "proximal" && priorGroundingEarly?.excerptTexts[0]
            ? priorGroundingEarly.excerptTexts[0]
            : retrievalSource === "span" && matchedSpanKind === "key-span"
              ? matchedSpanText
              : undefined,
        polarity,
      });
      if (single) {
        let singleRel = topRerankScore ?? Math.max(0, chosen.score);
        // G6c: prefer continuing the prior claim when ranking plans.
        if (
          continuity?.claim &&
          chosen.chunk.claim === continuity.claim
        ) {
          singleRel = Math.min(1, singleRel + 0.08);
          g6bReasons.push("g6c:plan-continue-claim");
        } else if (continuity?.chunkId === chosen.chunk.id) {
          singleRel = Math.min(1, singleRel + 0.05);
          g6bReasons.push("g6c:plan-continue-chunk");
        }
        candidates.push({
          id: "single",
          plan: single.plan,
          signals: planSignals(single.plan, {
            relevance: singleRel,
            nliEntail: single.nliScore,
          }),
        });
      }

      const selection = selectBestPlan(candidates);
      if (selection) {
        operationPlan = selection.winner.plan;
        if (g6bReasons.length) {
          operationPlan = {
            ...operationPlan,
            reasons: [...g6bReasons, ...operationPlan.reasons],
          };
        }
        if (selection.winner.id === "fuse" && fusedMeta) {
          fuseParts = fusePartsFromMatched(fusedMeta.parts, operationPlan);
          fusedWith = fusedWithFromPlan(operationPlan);
          fusedCompose = fusedComposeFromPlan(operationPlan);
          if (fusedMeta.nliLabel != null) nliLabel = fusedMeta.nliLabel;
          if (fusedMeta.nliScore != null) nliScore = fusedMeta.nliScore;
        } else if (single) {
          nliLabel = single.nliLabel;
          nliScore = single.nliScore;
        }
      }

      if (operationPlan) {
        operation = deriveOperationLabel(operationPlan);
        composePlan = primaryComposePlan(operationPlan);
        const rendered = renderOperationPlan(
          operationPlan,
          getChunk,
          chosen.chunk.lang,
          GROUNDED_OPENERS,
        );
        replyText = rendered;
        // Legacy: generated only when the reply was modified (not plain as-is).
        if (operation !== "as-is") generated = true;
      }
    }

    const queryText = composed.summary;

    // G6a: structured grounding on the reply; prior from last bot in history.
    const priorGrounding = priorGroundingEarly;
    const fullChosen =
      this.index.find((c) => c.id === chosen.chunk.id) ??
      ({
        ...chosen.chunk,
      } as ChunkRecord);
    const chunkByIdForGround = new Map(this.index.map((c) => [c.id, c]));
    const turnGrounding = buildTurnGrounding({
      chunk: fullChosen,
      operation,
      composePlan,
      fuseParts,
      getChunk: (id) => chunkByIdForGround.get(id),
    });

    return {
      message: {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: chosen.chunk.speaker,
        text: replyText,
        sourceChunkId: chosen.chunk.id,
        score: chosen.score,
        grounding: turnGrounding,
      },
      trace: {
        queryLang,
        anaphora,
        continuity: continuity
          ? {
              chunkId: continuity.chunkId,
              claim: continuity.claim,
              matchedChosen:
                chosen.chunk.id === continuity.chunkId ||
                (!!continuity.claim &&
                  chosen.chunk.claim === continuity.claim),
            }
          : undefined,
        priorGrounding,
        turnGrounding,
        chain: opts.chain,
        generated,
        operation,
        operationPlan,
        fusedWith,
        fuseParts,
        fusedCompose,
        composePlan,
        nliLabel,
        nliScore,
        retrievalSource,
        matchedSpanId,
        matchedSpanKind,
        spanScore,
        reranked: gated,
        gateFromFuse: gateFromFuse || undefined,
        topRerankScore,
        ceForwards: ce.forwardCount > 0 ? ce.forwardCount : undefined,
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
    opts: PredictOpts = {},
  ) {
    return this.predictNext(history, userText, "bot", opts);
  }

  async predictUser(history: ChatMessage[], opts: PredictOpts = {}) {
    return this.predictNext(history, undefined, "user", opts);
  }

  /** G6d: build the declarative chain demo recipe (no side effects). */
  buildChainPlan(lang: Lang, pairCount: number, userClaimOffset = 0) {
    return buildChainDemoPlan({ lang, pairCount, userClaimOffset });
  }

  /**
   * G6d: emit a message by claim from the corpus (copy-only).
   * Used for planned user turns (and optional corpus bot turns).
   */
  async emitClaim(opts: {
    claim: string;
    lang: Lang;
    role: "user" | "bot";
    chain?: ChainTraceMeta;
  }): Promise<{ message: ChatMessage; trace: TraceStep }> {
    const t0 = performance.now();
    if (this.index.length === 0) await this.ensureHash();
    const chunk = findChunkByClaim(opts.claim, opts.lang, opts.role);
    if (!chunk) {
      throw new Error(
        `chain claim not found: ${opts.claim}/${opts.lang}/${opts.role}`,
      );
    }
    const full =
      this.index.find((c) => c.id === chunk.id) ?? (chunk as ChunkRecord);
    const turnGrounding = buildTurnGrounding({
      chunk: full,
      operation: "as-is",
    });
    const hit: MatchHit = {
      chunk: {
        id: chunk.id,
        key: chunk.key,
        natKey: chunk.natKey,
        value: chunk.value,
        speaker: chunk.speaker,
        lang: chunk.lang,
        claim: chunk.claim,
        tags: chunk.tags,
      },
      score: 1,
    };
    return {
      message: {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: chunk.speaker,
        text: chunk.value,
        sourceChunkId: chunk.id,
        score: 1,
        grounding: turnGrounding,
      },
      trace: {
        queryLang: opts.lang,
        turnGrounding,
        chain: opts.chain,
        generated: false,
        operation: "as-is",
        queryText: `chain-emit:${opts.claim}`,
        querySummary: `chain-emit:${opts.claim}`,
        hits: [hit],
        chosen: hit,
        latencyMs: Math.round(performance.now() - t0),
      },
    };
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
