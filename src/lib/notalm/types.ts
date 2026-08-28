export type Speaker = "user" | "bot";

export type ChunkRecord = {
  id: string;
  /** Key: conversational context pattern that triggers this chunk */
  key: string;
  /** Value: next utterance predicted for this pattern */
  value: string;
  /** Who speaks the value */
  speaker: Speaker;
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
  | { kind: "ready"; backend: "hash" | "bekko"; chunkCount: number }
  | { kind: "error"; message: string };
