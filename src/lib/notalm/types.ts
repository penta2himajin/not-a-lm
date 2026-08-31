export type Speaker = "user" | "bot";

/** Supported corpus / query languages (v1: ja, en, zh-Hans) */
export type Lang = "ja" | "en" | "zh";

export type SpanRecord = {
  /** Stable id within the parent chunk (e.g. "no-gen", "item-knn") */
  id: string;
  /** Copied verbatim into composed replies — no generation */
  text: string;
  /** G4a planner hints (closed tag vocabulary) */
  tags?: string[];
  /** G4c: declarative NLI hypothesis for per-span scoring (premise = query) */
  nliHypothesis?: string;
};

export type SpanRef = {
  chunkId: string;
  spanId: string;
};

/** Auditable span-composition plan (G4). */
export type ComposePlan = {
  /** Optional closed prefix from G2 polarity (negation/affirmation opener) */
  prefix?: "negate-correct" | "affirm-confirm";
  kept: SpanRef[];
  /** Auto key-span text (copy-only) when no author span id matches */
  keySpanText?: string;
};

/**
 * G5 — one step in a declarative reply recipe.
 * Every output substring must come from corpus copy, closed glue, or a query span.
 */
export type OpStep =
  | {
      /** Closed polarity opener (G2 legacy when body has no composePlan) */
      kind: "prefix";
      which: "negate-correct" | "affirm-confirm";
    }
  | {
      /** Copy chunk value or G4-rendered body */
      kind: "body";
      chunkId: string;
      composePlan?: ComposePlan;
      /** Fusion non-first parts: strip closed leading filler */
      stripFiller?: boolean;
    }
  | {
      /** Closed topic connector; `topic` is copied from the query segment */
      kind: "glue";
      template: "topic";
      topic: string;
    };

/** G5 — declarative grounded-reply plan (planner output; renderer is pure). */
export type OperationPlan = {
  steps: OpStep[];
  /** Human-readable why this plan was chosen (audit / debug) */
  reasons: string[];
};

/**
 * G5d — one scored candidate before selection.
 * `id` is a closed vocabulary (fuse | single); score is heuristic, not learned.
 */
export type PlanCandidateId = "fuse" | "single";

export type PlanCandidateSignals = {
  /** Mean segment↔chunk relevance (fuse) or gate/top score (single), in ~[0,1] */
  relevance: number;
  /** Best NLI entailment tied to this plan, when available */
  nliEntail?: number;
  /** Number of body steps */
  bodies: number;
  hasCompose: boolean;
  hasPolarity: boolean;
};

export type PlanCandidate = {
  id: PlanCandidateId;
  plan: OperationPlan;
  signals: PlanCandidateSignals;
  /** Set after scorePlanCandidate */
  score?: number;
};

/** One segment→chunk mapping in G3 fusion (with optional G4 compose). */
export type FusePartTrace = {
  chunkId: string;
  segment: string;
  composePlan?: ComposePlan;
};

export type ChunkRecord = {
  id: string;
  /** Keyword-bag key: used only as the cross-encoder confidence-gate input */
  key: string;
  /** Natural-sentence key: used for bi-encoder ranking (better topic separation) */
  natKey: string;
  /** Value: next utterance predicted for this pattern (joined spans for display) */
  value: string;
  /**
   * Author-defined spans for G4 composition. When present, `value` should equal
   * the joined span texts (see joinSpanTexts in compose.ts).
   */
  spans?: SpanRecord[];
  /** Who speaks the value */
  speaker: Speaker;
  /** Language of key/value; used to route replies to the query's language */
  lang: Lang;
  /** Language-neutral claim id shared across localized variants (for future cross-lingual work) */
  claim?: string;
  /**
   * Declarative positive claim(s) this chunk is about, used as NLI hypotheses
   * for presupposition detection in grounded generation (only on polarizable
   * chunks). Multiple phrasings improve robustness to how the user asks; NLI is
   * run against each and the max entailment is used. E.g. ["You generate with RAG."]
   */
  assertions?: string[];
  /**
   * Whether the chunk's fact affirms or denies its `assertions`.
   * - "deny": a query that presupposes the assertion (NLI entailment) is a false
   *   presupposition → grounded generation prepends a negation/correction.
   * - "affirm": the presupposition is true → grounded generation prepends an
   *   affirmation.
   */
  stance?: "affirm" | "deny";
  tags: string[];
};

export type IndexedChunk = ChunkRecord & {
  embedding: Float32Array;
};

export type MatchHit = {
  chunk: ChunkRecord;
  /** Stage-1 bi-encoder cosine score (with reuse penalty applied) */
  score: number;
  /** Stage-2 cross-encoder relevance in [0,1]; present when reranked */
  rerankScore?: number;
  /** Dual-index: best span cosine for this chunk (when merged) */
  spanScore?: number;
};

export type TraceStep = {
  /** Detected query language used to filter candidates */
  queryLang?: Lang;
  /** Whether the cross-encoder reranker reordered the candidates */
  reranked?: boolean;
  /** Best cross-encoder relevance score for this turn (when reranked) */
  topRerankScore?: number;
  /** Raw bi-encoder cosine of the ranking top-1 (nearest corpus element) */
  topCosine?: number;
  /** True when a low reranker score was overridden by a very-high top cosine */
  rescued?: boolean;
  /** True when the best score was below the confidence gate → graceful refusal */
  lowConfidence?: boolean;
  /** Grounded generation: whether the reply was composed (vs returned as-is) */
  generated?: boolean;
  /** Grounded generation operation applied */
  operation?: "as-is" | "negate-correct" | "affirm-confirm" | "fuse" | "compose";
  /** For fuse: the id of the second chunk combined into the reply */
  fusedWith?: string;
  /** G3 fusion: per-segment chunk mapping (+ G4 plan when narrowed) */
  fuseParts?: FusePartTrace[];
  /** True when any fused part used G4 compose */
  fusedCompose?: boolean;
  /** G4 span composition plan (when operation is compose, or polarity+compose) */
  composePlan?: ComposePlan;
  /**
   * G5: declarative reply recipe (steps). Legacy `operation` remains the
   * derived summary label until callers migrate to plan-only.
   */
  operationPlan?: OperationPlan;
  /** Dual-index: natKey vs span secondary retrieval */
  retrievalSource?: "natKey" | "span";
  /** Span entry id when retrievalSource is span (author id or auto-{n}) */
  matchedSpanId?: string;
  matchedSpanKind?: "author" | "key-span";
  spanScore?: number;
  /** NLI(query, chunk.assertion) top label + score, when grounded generation ran */
  nliLabel?: string;
  nliScore?: number;
  /** Legacy one-line query description */
  queryText: string;
  /** Exponential weighted query composition details */
  querySummary?: string;
  queryTurns?: {
    role: Speaker;
    text: string;
    age: number;
    finalWeight: number;
    anchorSimilarity: number;
    included: boolean;
    pairIndex?: number;
  }[];
  queryPairs?: {
    index: number;
    userText: string;
    botText?: string;
    anchorSimilarity: number;
    chainSimilarity?: number;
    included: boolean;
    finalWeight: number;
  }[];
  hits: MatchHit[];
  chosen: MatchHit;
  latencyMs: number;
};

export type ChatMessage = {
  id: string;
  role: Speaker;
  text: string;
  sourceChunkId?: string;
  score?: number;
};

export type EngineStatus =
  | { kind: "booting"; detail: string }
  | { kind: "ready"; backend: "hash" | "dense"; chunkCount: number }
  | { kind: "error"; message: string };
