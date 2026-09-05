import { CHUNK_CORPUS, CORPUS_CLAIMS } from "./corpus";
import {
  buildClaimEdgeIndex,
  elaboratesSatellite,
  fusePairBonus,
  orderPartsByNuclearity,
  relationBetween,
  retrievalEdgeBonus,
  type ClaimEdgeIndex,
} from "./topic-edges";
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
import {
  buildChainDemoPlan,
  findChunkByClaim,
} from "./chain-plan";
import {
  buildTurnGrounding,
  classifyAnaphora,
  continuityFromPrior,
  isElaborationProximal,
  proximalFocusRef,
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
  scorePlanCandidate,
  selectBestPlan,
} from "./plan";
import {
  previewCompoundSegments,
  segmentCandidates,
} from "./segment";
import {
  buildSpanIndexManifest,
  KEY_POOL,
  mergeDualRetrieval,
  searchSpanIndex,
  SPAN_AUTHOR_MIN_COS,
  topicRescueClaims,
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
  TraceDebug,
  TraceStep,
} from "./types";

function markMs(t0: number): number {
  return Math.round(performance.now() - t0);
}

function logTurnDebug(payload: Record<string, unknown>): void {
  // Always emit one JSON line so cloud logs + user reports stay aligned.
  try {
    console.info("[notalm:turn]", JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

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
/** CE reroute: swap chosen when a gate candidate wins by at least this margin. */
const GATE_REROUTE_MARGIN = 0.25;
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
 * Fusion: if the top two candidates are BOTH strongly relevant (gate score) and
 * cover different topics, combine them into one reply with a closed connective.
 * High threshold so fusion only fires for genuinely compound/broad questions.
 */
const FUSE_MIN = 0.5;

/**
 * Fluent topic connector / stripLeadingFiller / polarity openers live in plan.ts
 * (G5 renderer). Engine only segments queries for fusion matching.
 */
export class ChunkKVEngine {
  private index: IndexedChunk[] = [];
  private spanIndex: SpanIndexEntry[] = [];
  private backend: EmbedBackend = "hash";
  private usedIds = new Set<string>();
  private edgeIndex: ClaimEdgeIndex = buildClaimEdgeIndex(CORPUS_CLAIMS);
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
      const adjusted = adjustScoreForContinuity(
        raw,
        chunk,
        this.usedIds,
        continuity,
      );
      let score = adjusted.score;
      score += retrievalEdgeBonus(
        this.edgeIndex,
        continuity?.claim,
        chunk.claim,
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

  private indexedChunkRecord(
    row: ChunkRecord & { embedding: Float32Array },
  ): ChunkRecord {
    const { embedding: _e, ...chunk } = row;
    return chunk;
  }

  /**
   * Stage 2 (gate): score keyword keys with the cross-encoder. Optionally
   * reroute `chosen` when a topic-rescue candidate (e.g. help-1 on「何ができる」)
   * clearly beats the bi-encoder top-1 on CE.
   */
  private async gateConfidence(
    query: string,
    keyHits: MatchHit[],
    chosen: MatchHit,
    lang: Lang,
    opts: { allowReroute?: boolean } = {},
  ): Promise<{ topScore: number; chosen: MatchHit; rerouted: boolean }> {
    const candidates: MatchHit[] = keyHits.slice(0, GATE_CANDIDATES).map((h) => ({
      ...h,
    }));
    const seen = new Set(candidates.map((h) => h.chunk.id));

    const addCandidate = (hit: MatchHit) => {
      if (seen.has(hit.chunk.id)) return;
      candidates.push(hit);
      seen.add(hit.chunk.id);
    };

    addCandidate({ ...chosen });

    for (const claim of topicRescueClaims(query)) {
      const row = this.index.find(
        (c) => c.claim === claim && c.lang === lang && c.speaker === "bot",
      );
      if (!row) continue;
      addCandidate({
        chunk: this.indexedChunkRecord(row),
        score: 0,
      });
    }

    const scores = await rerankScores(
      query,
      candidates.map((h) => h.chunk.key),
    );
    let bestIdx = 0;
    let bestScore = scores[0] ?? 0;
    candidates.forEach((h, i) => {
      h.rerankScore = scores[i];
      if ((scores[i] ?? 0) > bestScore) {
        bestScore = scores[i] ?? 0;
        bestIdx = i;
      }
    });

    keyHits.slice(0, GATE_CANDIDATES).forEach((h) => {
      const idx = candidates.findIndex((c) => c.chunk.id === h.chunk.id);
      if (idx >= 0) h.rerankScore = scores[idx];
    });

    const chosenIdx = candidates.findIndex((c) => c.chunk.id === chosen.chunk.id);
    const chosenScore = chosenIdx >= 0 ? (scores[chosenIdx] ?? 0) : 0;
    let rerouted = false;
    const allowReroute = opts.allowReroute !== false;
    if (
      allowReroute &&
      bestScore >= GATE_MIN_SCORE &&
      bestIdx !== chosenIdx &&
      bestScore >= chosenScore + GATE_REROUTE_MARGIN
    ) {
      chosen = {
        ...candidates[bestIdx],
        score: candidates[bestIdx].score || chosen.score,
      };
      rerouted = true;
    } else if (chosenIdx >= 0) {
      chosen = { ...chosen, rerankScore: chosenScore };
    }

    return { topScore: bestScore, chosen, rerouted };
  }

  /** Distinct segments chosen for fusion (sync preview; rescored in fuseCompound). */
  private compoundSegments(query: string, lang: Lang): string[] {
    return previewCompoundSegments(query, lang);
  }


  /**
   * S3: when bipartite fuse misses, try an edge-anchored pair from the
   * current single winner + a static-edge neighbor for the other segment.
   */
  private async fuseEdgeAnchoredFallback(
    query: string,
    anchor: ChunkRecord,
    lang: Lang,
  ): Promise<{
    plan: OperationPlan;
    parts: { seg: string; chunk: ChunkRecord; score: number }[];
    segments: string[];
    nliLabel?: string;
    nliScore?: number;
  } | null> {
    const claim = anchor.claim?.trim();
    if (!claim) return null;
    const segments = this.compoundSegments(query, lang);
    if (segments.length < 2) return null;
    const neighborClaims = new Set<string>();
    for (const edge of this.edgeIndex.byClaim.get(claim) ?? []) {
      const other = edge.from === claim ? edge.to : edge.from;
      if (other) neighborClaims.add(other);
    }
    if (neighborClaims.size === 0) return null;

    const neighborRows = [...neighborClaims]
      .map((id) =>
        this.index.find(
          (c) => c.claim === id && c.lang === lang && c.speaker === "bot",
        ),
      )
      .filter((r): r is IndexedChunk => Boolean(r))
      .map((r) => this.indexedChunkRecord(r));
    if (neighborRows.length === 0) return null;

    const floor = FUSE_MIN - 0.12;
    const keys = [anchor.key, ...neighborRows.map((n) => n.key)];
    const scores0 = await rerankScores(segments[0], keys);
    const scores1 = await rerankScores(segments[1], keys);
    type Cand = { parts: { seg: string; chunk: ChunkRecord; score: number }[]; sum: number };
    const cands: Cand[] = [];
    // anchor→seg0, neighbor→seg1
    for (let j = 0; j < neighborRows.length; j++) {
      const a0 = scores0[0] ?? 0;
      const n1 = scores1[j + 1] ?? 0;
      if (a0 >= floor && n1 >= floor) {
        cands.push({
          sum: a0 + n1,
          parts: [
            { seg: segments[0], chunk: anchor, score: a0 },
            { seg: segments[1], chunk: neighborRows[j], score: n1 },
          ],
        });
      }
    }
    // neighbor→seg0, anchor→seg1 (order may flip for nuclearity later)
    for (let j = 0; j < neighborRows.length; j++) {
      const n0 = scores0[j + 1] ?? 0;
      const a1 = scores1[0] ?? 0;
      if (n0 >= floor && a1 >= floor) {
        cands.push({
          sum: n0 + a1,
          parts: [
            { seg: segments[0], chunk: neighborRows[j], score: n0 },
            { seg: segments[1], chunk: anchor, score: a1 },
          ],
        });
      }
    }
    cands.sort((a, b) => b.sum - a.sum);
    for (const cand of cands) {
      const ordered = orderPartsByNuclearity(cand.parts, this.edgeIndex);
      const planned = await planFuseParts(ordered.parts, lang);
      if (!planned) continue;
      planned.plan.reasons = [
        `s3:edge-anchored-fallback:${ordered.parts.map((p) => p.chunk.claim).join("↔")}`,
        ...ordered.notes,
        ...planned.plan.reasons,
      ];
      return {
        plan: planned.plan,
        parts: ordered.parts,
        segments,
        nliLabel: planned.nliLabel,
        nliScore: planned.nliScore,
      };
    }
    return null;
  }

  /**
   * S3: expand fuse candidate pool with static-edge neighbors of top hits.
   * Soft recall only — CE still decides the assignment.
   */
  private enrichFuseCandidatesWithEdges(
    cands: MatchHit[],
    lang: Lang,
  ): MatchHit[] {
    const have = new Set(
      cands.map((c) => c.chunk.claim).filter((x): x is string => Boolean(x)),
    );
    const out = cands.slice();
    for (const hit of cands.slice(0, 6)) {
      const claim = hit.chunk.claim?.trim();
      if (!claim) continue;
      for (const edge of this.edgeIndex.byClaim.get(claim) ?? []) {
        const other = edge.from === claim ? edge.to : edge.from;
        if (!other || have.has(other)) continue;
        const row = this.index.find(
          (c) =>
            c.claim === other &&
            c.lang === lang &&
            c.speaker === "bot",
        );
        if (!row) continue;
        have.add(other);
        out.push({
          chunk: this.indexedChunkRecord(row),
          score: hit.score * 0.85,
        });
      }
    }
    return out;
  }

  /** Bipartite segment→chunk matching for one partition candidate. */
  private async fuseMatchPartition(
    segments: string[],
    cands: MatchHit[],
  ): Promise<{
    parts: { seg: string; chunk: ChunkRecord; score: number }[];
    totalScore: number;
  } | null> {
    if (segments.length < 2 || cands.length < 2) return null;

    const rr: number[][] = [];
    for (let i = 0; i < segments.length; i++) {
      rr.push(await rerankScores(segments[i], cands.map((c) => c.chunk.key)));
    }
    // Soft dampen off-topic social/help claims on identity/mechanism segments.
    const helpSeg = (seg: string) =>
      /使い方|ヘルプ|例|できること|サンプル|help|how to use|what can you/i.test(
        seg,
      );
    const greetSeg = (seg: string) =>
      /こんにちは|やあ|hello|hi|おはよう|挨拶/i.test(seg);
    for (let i = 0; i < segments.length; i++) {
      for (let j = 0; j < cands.length; j++) {
        const tags = cands[j].chunk.tags ?? [];
        const claim = cands[j].chunk.claim ?? "";
        if (
          !helpSeg(segments[i]) &&
          (tags.includes("help") || claim.startsWith("help-"))
        ) {
          rr[i][j] *= 0.45;
        }
        if (
          !greetSeg(segments[i]) &&
          (tags.includes("greeting") ||
            claim.startsWith("greet-") ||
            claim.startsWith("var-hello"))
        ) {
          rr[i][j] *= 0.4;
        }
      }
    }
    const pairs: { i: number; j: number; s: number }[] = [];
    for (let i = 0; i < segments.length; i++) {
      for (let j = 0; j < cands.length; j++) pairs.push({ i, j, s: rr[i][j] });
    }
    // S3: soft bonus when a candidate claim is statically edged to another
    // candidate that scores well on a different segment (prefer authored pairs).
    for (let i = 0; i < segments.length; i++) {
      for (let j = 0; j < cands.length; j++) {
        const cj = cands[j].chunk.claim;
        if (!cj) continue;
        let bestLink = 0;
        for (let i2 = 0; i2 < segments.length; i2++) {
          if (i2 === i) continue;
          for (let j2 = 0; j2 < cands.length; j2++) {
            if (j2 === j) continue;
            const bonus = fusePairBonus(
              this.edgeIndex,
              cj,
              cands[j2].chunk.claim,
            );
            if (bonus > 0 && rr[i2][j2] >= FUSE_MIN) {
              bestLink = Math.max(bestLink, bonus);
            }
          }
        }
        if (bestLink > 0) rr[i][j] += bestLink;
      }
    }
    // rebuild pairs with boosted scores
    pairs.length = 0;
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
    if (new Set(parts.map((p) => p.chunk.id)).size < 2) return null;

    const totalScore = parts.reduce((sum, p) => sum + p.score, 0);
    return { parts, totalScore };
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
    continuity?: ContinuityHint,
  ): Promise<{
    plan: OperationPlan;
    parts: { seg: string; chunk: ChunkRecord; score: number }[];
    segments: string[];
    nliLabel?: string;
    nliScore?: number;
  } | null> {
    const cands = this.enrichFuseCandidatesWithEdges(
      this.search(queryVec, "bot", lang, 12, continuity),
      lang,
    );
    if (cands.length < 2) return null;

    const partitions = segmentCandidates(query, lang);
    let bestMatch: {
      parts: { seg: string; chunk: ChunkRecord; score: number }[];
      totalScore: number;
    } | null = null;
    let bestSegments: string[] = [];

    for (const segments of partitions) {
      if (segments.length < 2) continue;
      const matched = await this.fuseMatchPartition(segments, cands);
      if (!matched) continue;
      if (
        !bestMatch ||
        matched.totalScore > bestMatch.totalScore ||
        (matched.totalScore === bestMatch.totalScore &&
          segments.length < bestSegments.length)
      ) {
        bestMatch = matched;
        bestSegments = segments;
      }
    }

    if (!bestMatch) return null;

    const ordered = orderPartsByNuclearity(bestMatch.parts, this.edgeIndex);
    const planned = await planFuseParts(ordered.parts, lang);
    if (!planned) return null;
    if (ordered.notes.length) {
      planned.plan.reasons = [...ordered.notes, ...planned.plan.reasons];
    }
    return {
      plan: planned.plan,
      parts: ordered.parts,
      segments: bestSegments,
      nliLabel: planned.nliLabel,
      nliScore: planned.nliScore,
    };
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
    let tMark = t0;
    const timingMs: NonNullable<TraceStep["timingMs"]> = {};
    const debugNotes: string[] = [];

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
      debugNotes.push(
        anaphora === "proximal"
          ? "anaphora:non-proximal→proximal(single-prior)"
          : "anaphora:non-proximal→none(no-prior)",
      );
    }

    // G6c: continuity only for proximal follow-ups (topic shift must not stick).
    const continuity: ContinuityHint | undefined =
      preferSpeaker === "bot" && anaphora === "proximal"
        ? continuityFromPrior(priorGroundingEarly)
        : undefined;
    if (preferSpeaker === "bot" && anaphora !== "proximal" && priorGroundingEarly) {
      debugNotes.push("g6c:skipped(non-proximal)");
    }

    // G6b-proximal: focus refs for compose — do NOT concatenate into the
    // retrieval/gate query (that caused topic-lock on "それって RAG…").
    const g6bReasons: string[] = [];
    const proximalFocus =
      anaphora === "proximal" && preferSpeaker === "bot"
        ? proximalFocusRef(priorGroundingEarly)
        : null;
    if (proximalFocus) g6bReasons.push(...proximalFocus.reasons);

    // Always use the raw user text for retrieval + gate (contract: single path,
    // no query pollution). History bias stays in composeQueryVector.
    const planningUser = rawUser;
    timingMs.context = markMs(tMark);
    tMark = performance.now();

    const composed = await composeQueryVector(
      history,
      planningUser || latestUser,
      this.backend,
    );
    timingMs.queryEmbed = markMs(tMark);
    tMark = performance.now();

    // Bot replies always run grounded planning (contract). `generate: false` is
    // ignored on the main path; kept on the wire for older clients only.
    const useGrounded = preferSpeaker === "bot";
    if (preferSpeaker === "bot" && opts.generate === false) {
      debugNotes.push("generate:false-ignored(contract-always-ground)");
    }

    const compoundSegsEarly = this.compoundSegments(
      planningUser || rawUser,
      queryLang,
    );
    let compoundSegsResolved = compoundSegsEarly;

    const buildDebugBase = (extra: Partial<TraceDebug> = {}): TraceDebug => {
      const notes = [...debugNotes, ...(extra.notes ?? [])];
      const intentional: string[] = [];
      if (proximalFocus?.claim) intentional.push(`focus-claim:${proximalFocus.claim}`);
      if (continuity?.claim) intentional.push(`continuity-claim:${continuity.claim}`);
      for (const n of notes) {
        if (n.startsWith("s3:")) intentional.push(n);
      }
      const attentional: string[] = [`anaphora:${anaphora}`];
      if (proximalFocus) attentional.push("proximal-focus-ref");
      if (continuity) attentional.push("continuity-applied");
      else if (anaphora === "proximal") attentional.push("continuity-absent");
      if (anaphora === "non-proximal") attentional.push("clarify-candidate");
      const discourseLayerHints: NonNullable<TraceDebug["discourseLayerHints"]> = {
        linguistic: [
          ...compoundSegsResolved.map((s, i) => `seg${i}:${s.slice(0, 40)}`),
          ...(extra.discourseLayerHints?.linguistic ?? []),
        ],
        intentional: [
          ...intentional,
          ...(extra.discourseLayerHints?.intentional ?? []),
        ],
        attentional: [
          ...attentional,
          ...(extra.discourseLayerHints?.attentional ?? []),
        ],
      };
      return {
        rawUser,
        planningUser,
        gateQuery: planningUser || composed.anchorText || rawUser || "",
        preferSpeaker,
        useGrounded,
        anaphora,
        compoundSegments: compoundSegsResolved,
        proximalFocus: proximalFocus
          ? {
              chunkId: proximalFocus.chunkId,
              claim: proximalFocus.claim,
              spanId: proximalFocus.spanId,
              excerptPreview: proximalFocus.excerpt?.slice(0, 80),
            }
          : undefined,
        continuityApplied: Boolean(continuity),
        continuity: continuity
          ? { chunkId: continuity.chunkId, claim: continuity.claim }
          : undefined,
        ...extra,
        discourseLayerHints,
        notes,
      };
    };

    // G6b-clarify: short-circuit before retrieve/gate (avoid OOC refuse on さっきの).
    if (
      useGrounded &&
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
      timingMs.total = markMs(t0);
      const debug = buildDebugBase({
        notes: ["path:clarify-short-circuit"],
        winnerPlanId: "clarify",
      });
      logTurnDebug({
        path: "clarify",
        lang: queryLang,
        anaphora,
        latencyMs: timingMs.total,
        timingMs,
        chosen: anchorChunk.id,
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
          latencyMs: timingMs.total ?? markMs(t0),
          timingMs,
          debug,
        },
      };
    }

    // Stage 1 (ranking): bi-encoder over natural keys (+ dual-index span merge).
    tMark = performance.now();
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
    timingMs.retrieve = markMs(tMark);
    tMark = performance.now();

    let chosen = hits[0];
    if (!chosen) throw new Error("チャンクが空です");

    // G6b-elaboration: 「何が」「詳しく」etc. continue the prior bot turn — keyword
    // gate/reroute cannot interpret elliptical follow-ups and will drift (e.g. greet).
    let elaborationPin = false;
    if (
      preferSpeaker === "bot" &&
      anaphora === "proximal" &&
      isElaborationProximal(rawUser, queryLang) &&
      priorGroundingEarly
    ) {
      const priorRow = this.index.find(
        (c) => c.id === priorGroundingEarly.chunkId,
      );
      if (priorRow) {
        // S2/S3: prefer authored detailClaim, else elaborates satellite (copy-only).
        let pinRow = priorRow;
        const detailId =
          priorRow.detailClaim?.trim() ||
          elaboratesSatellite(this.edgeIndex, priorRow.claim);
        if (detailId) {
          const detailRow = this.index.find(
            (c) =>
              c.claim === detailId &&
              c.lang === priorRow.lang &&
              c.speaker === "bot",
          );
          if (detailRow) {
            pinRow = detailRow;
            debugNotes.push(
              `proximal:elaboration-detail=${priorRow.claim}→${detailId}`,
            );
          } else {
            debugNotes.push(
              `proximal:elaboration-detail-missing=${detailId}`,
            );
          }
        }
        chosen = {
          chunk: this.indexedChunkRecord(pinRow),
          score: Math.max(chosen.score, 1),
        };
        elaborationPin = true;
        debugNotes.push(`proximal:elaboration-pin=${pinRow.claim}`);
      }
    }

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
    let gated = false;
    let topRerankScore: number | undefined;
    let lowConfidence = false;
    let rescued = false;
    let gateRerouted = false;
    let spanGateBypass =
      retrievalSource === "span" &&
      matchedSpanKind === "author" &&
      (spanScore ?? 0) >= SPAN_AUTHOR_MIN_COS;

    if (isRerankerReady() && gateQuery && preferSpeaker === "bot" && !elaborationPin) {
      try {
        // Gate on pre-merge key pool + merged winner (span rescue may sit outside key top-K).
        const gate = await this.gateConfidence(
          gateQuery,
          keyHitsForGate,
          chosen,
          queryLang,
          { allowReroute: anaphora !== "proximal" },
        );
        topRerankScore = gate.topScore;
        chosen = gate.chosen;
        gateRerouted = gate.rerouted;
        if (gateRerouted) {
          debugNotes.push(`gate:reroute=${chosen.chunk.claim}`);
          spanGateBypass = false;
          retrievalSource = "natKey";
        }
        gated = true;
      } catch {
        /* gate unavailable: fall through without refusing */
        debugNotes.push("gate:error-skipped");
      }
    }
    timingMs.gate = markMs(tMark);
    tMark = performance.now();

    const gateTop = keyHitsForGate.slice(0, GATE_CANDIDATES).map((h) => ({
      id: h.chunk.id,
      claim: h.chunk.claim,
      rerank: h.rerankScore,
    }));

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
    let planCandidateDebug: TraceDebug["planCandidates"];
    let winnerPlanId: string | undefined;

    if (useGrounded && !lowConfidence) {
      const chunkById = new Map(this.index.map((c) => [c.id, c]));
      const getChunk = (id: string) => chunkById.get(id);

      const tPol = performance.now();
      const polarity = await peekPolarity(gateQuery, chosen.chunk);
      timingMs.polarity = markMs(tPol);
      nliLabel = polarity.nliLabel;
      nliScore = polarity.nliScore;

      const candidates: PlanCandidate[] = [];
      let fusedMeta: {
        parts: { seg: string; chunk: ChunkRecord; score: number }[];
        segments: string[];
        nliLabel?: string;
        nliScore?: number;
      } | null = null;

      if (isRerankerReady()) {
        const tFuse = performance.now();
        const fused = await this.fuseCompound(
          gateQuery,
          composed.vector,
          chosen.chunk.lang,
          continuity,
        );
        timingMs.fuse = markMs(tFuse);
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
          const edgeNotes: string[] = [];
            if (fused.parts.length >= 2) {
              const ca = fused.parts[0].chunk.claim;
              const cb = fused.parts[1].chunk.claim;
              const rel = relationBetween(this.edgeIndex, ca, cb);
              if (rel) edgeNotes.push(`s3:static-edge:${rel}:${ca}↔${cb}`);
            }
            for (const n of edgeNotes) debugNotes.push(n);
            fusedMeta = {
              parts: fused.parts,
              segments: fused.segments,
              nliLabel: fused.nliLabel,
              nliScore: fused.nliScore,
            };
          compoundSegsResolved = fused.segments;
        } else {
          debugNotes.push("fuse:null");
          const anchored = await this.fuseEdgeAnchoredFallback(
            gateQuery,
            chosen.chunk,
            chosen.chunk.lang,
          );
          if (anchored) {
            const meanRel =
              anchored.parts.reduce((a, p) => a + p.score, 0) /
              anchored.parts.length;
            candidates.push({
              id: "fuse",
              plan: anchored.plan,
              signals: planSignals(anchored.plan, {
                relevance: meanRel,
                nliEntail: anchored.nliScore,
              }),
            });
            const ca = anchored.parts[0]?.chunk.claim;
            const cb = anchored.parts[1]?.chunk.claim;
            const rel = relationBetween(this.edgeIndex, ca, cb);
            if (rel) debugNotes.push(`s3:static-edge:${rel}:${ca}↔${cb}`);
            debugNotes.push("s3:edge-anchored-fallback");
            fusedMeta = {
              parts: anchored.parts,
              segments: anchored.segments,
              nliLabel: anchored.nliLabel,
              nliScore: anchored.nliScore,
            };
            compoundSegsResolved = anchored.segments;
          }
        }
      }

      const sameChunkProximal =
        !elaborationPin &&
        Boolean(proximalFocus) &&
        Boolean(priorGroundingEarly) &&
        priorGroundingEarly!.chunkId === chosen.chunk.id;
      if (proximalFocus && !sameChunkProximal && !elaborationPin) {
        debugNotes.push("proximal-focus:skipped(different-chunk)");
      }

      const tSingle = performance.now();
      const single = elaborationPin
        ? {
            plan: {
              steps: [
                {
                  kind: "body" as const,
                  chunkId: chosen.chunk.id,
                },
              ],
              reasons: ["elaboration:full-keep", ...g6bReasons],
            },
            nliLabel: polarity.nliLabel,
            nliScore: polarity.nliScore,
          }
        : await planSingleChunk({
            query: gateQuery,
            chunk: chosen.chunk,
            lang: chosen.chunk.lang,
            // Elaboration follow-ups handled above; reference proximal may pass focus.
            focusSpanId: sameChunkProximal ? proximalFocus?.spanId : undefined,
            focusKeySpanText: sameChunkProximal
              ? proximalFocus?.excerpt
              : undefined,
            polarity,
          });
      timingMs.single = markMs(tSingle);
      if (single) {
        let singleRel = topRerankScore ?? Math.max(0, chosen.score);
        // G6c: prefer continuing the prior claim when ranking plans (proximal only).
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

      const tSel = performance.now();
      planCandidateDebug = candidates.map((c) => ({
        id: c.id,
        score: scorePlanCandidate(c),
        relevance: c.signals.relevance,
        reasons: c.plan.reasons.slice(0, 8),
      }));
      const selection = selectBestPlan(candidates);
      if (selection) {
        winnerPlanId = selection.winner.id;
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
        // Contract: always planned. Mark generated unless steps are pure full body.
        generated = operation !== "as-is";
      }
      timingMs.selectRender = markMs(tSel);
    } else if (lowConfidence) {
      debugNotes.push("plan:skipped(lowConfidence)");
    } else if (!useGrounded) {
      debugNotes.push("plan:skipped(!useGrounded)");
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

    timingMs.total = markMs(t0);
    const debug = buildDebugBase({
      spanGateBypass,
      gateTop,
      planCandidates: planCandidateDebug,
      winnerPlanId,
    });
    logTurnDebug({
      path: lowConfidence ? "refuse" : operation ?? "raw",
      lang: queryLang,
      anaphora,
      continuityApplied: Boolean(continuity),
      chosen: chosen.chunk.id,
      claim: chosen.chunk.claim,
      op: operation,
      winnerPlanId,
      topRerank: topRerankScore,
      topCosine,
      lowConfidence,
      rescued,
      latencyMs: timingMs.total,
      timingMs,
      notes: debug.notes,
      proximalFocus: debug.proximalFocus,
      compoundSegments: debug.compoundSegments,
      planCandidates: planCandidateDebug,
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
        latencyMs: timingMs.total ?? markMs(t0),
        timingMs,
        debug,
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
