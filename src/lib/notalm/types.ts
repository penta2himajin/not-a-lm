export type Speaker = "user" | "bot";

/** Supported corpus / query languages (v1: ja, en, zh-Hans) */
export type Lang = "ja" | "en" | "zh";

export type ChunkRecord = {
  id: string;
  /** Keyword-bag key: used only as the cross-encoder confidence-gate input */
  key: string;
  /** Natural-sentence key: used for bi-encoder ranking (better topic separation) */
  natKey: string;
  /** Value: next utterance predicted for this pattern */
  value: string;
  /** Who speaks the value */
  speaker: Speaker;
  /** Language of key/value; used to route replies to the query's language */
  lang: Lang;
  /** Language-neutral claim id shared across localized variants (for future cross-lingual work) */
  claim?: string;
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
};

export type TraceStep = {
  /** Detected query language used to filter candidates */
  queryLang?: Lang;
  /** Whether the cross-encoder reranker reordered the candidates */
  reranked?: boolean;
  /** Best cross-encoder relevance score for this turn (when reranked) */
  topRerankScore?: number;
  /** True when the best score was below the confidence gate → graceful refusal */
  lowConfidence?: boolean;
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
