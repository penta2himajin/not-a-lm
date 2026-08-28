export type Speaker = "user" | "bot";

/** Supported corpus / query languages (v1: ja, en, zh-Hans) */
export type Lang = "ja" | "en" | "zh";

export type ChunkRecord = {
  id: string;
  /** Key: conversational context pattern that triggers this chunk */
  key: string;
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
  score: number;
};

export type TraceStep = {
  /** Detected query language used to filter candidates */
  queryLang?: Lang;
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
