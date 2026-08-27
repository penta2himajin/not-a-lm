import { CHUNK_CORPUS } from "./corpus";
import {
  BEKKO_MODEL_ID,
  cosine,
  embed,
  embedMany,
  getBekkoProgress,
  isBekkoReady,
  loadBekko,
  type EmbedBackend,
} from "./embed";
import type {
  ChatMessage,
  ChunkRecord,
  EngineStatus,
  IndexedChunk,
  MatchHit,
  TraceStep,
} from "./types";

const RECENT_TURNS = 4;
const TOP_K = 5;

function buildQueryText(history: ChatMessage[], latestUser?: string): string {
  const recent = history.slice(-RECENT_TURNS);
  const lines = recent.map(
    (m) => `${m.role === "user" ? "User" : "Bot"}: ${m.text}`,
  );
  if (latestUser) lines.push(`User: ${latestUser}`);
  return lines.join("\n");
}

export class ChunkKVEngine {
  private index: IndexedChunk[] = [];
  private backend: EmbedBackend = "hash";
  private usedIds = new Set<string>();
  private initPromise: Promise<void> | null = null;

  get status(): EngineStatus {
    if (this.index.length === 0) {
      return { kind: "booting", detail: getBekkoProgress() || "起動中" };
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
    return this.backend === "bekko" ? BEKKO_MODEL_ID : "hash-ngram-384";
  }

  /** Instant hash index so the UI can talk while bekko downloads */
  async ensureHash(): Promise<void> {
    if (this.index.length > 0 && this.backend === "hash") return;
    if (this.index.length > 0 && this.backend === "bekko") return;

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

  /** Load bekko-a8m and rebuild the chunk KV index */
  async ensureBekko(
    onProgress?: (msg: string) => void,
  ): Promise<{ upgraded: boolean }> {
    if (this.backend === "bekko" && isBekkoReady() && this.index.length > 0) {
      return { upgraded: false };
    }

    if (!this.initPromise) {
      this.initPromise = (async () => {
        await loadBekko(onProgress);
        onProgress?.("チャンクキーを bekko で埋め込み中…");
        const vectors = await embedMany(
          CHUNK_CORPUS.map((c) => c.key),
          "bekko",
          (done, total) => onProgress?.(`チャンク ${done}/${total}`),
        );
        this.backend = "bekko";
        this.index = CHUNK_CORPUS.map((c, i) => ({
          ...c,
          embedding: vectors[i],
        }));
        this.usedIds.clear();
        onProgress?.("bekko-a8m インデックス完了");
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
  ): MatchHit[] {
    const scored: MatchHit[] = [];
    for (const chunk of this.index) {
      let score = cosine(queryVec, chunk.embedding);
      if (preferSpeaker && chunk.speaker === preferSpeaker) score += 0.035;
      if (this.usedIds.has(chunk.id)) score -= 0.12;
      scored.push({
        chunk: {
          id: chunk.id,
          key: chunk.key,
          value: chunk.value,
          speaker: chunk.speaker,
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
    const queryText = buildQueryText(history, latestUser);
    const queryVec = await embed(queryText, this.backend);
    const hits = this.search(queryVec, preferSpeaker);
    const chosen = hits[0];
    if (!chosen) throw new Error("チャンクが空です");

    this.usedIds.add(chosen.chunk.id);
    if (this.usedIds.size > 24) {
      this.usedIds = new Set([...this.usedIds].slice(-12));
    }

    return {
      message: {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: chosen.chunk.speaker,
        text: chosen.chunk.value,
        sourceChunkId: chosen.chunk.id,
        score: chosen.score,
      },
      trace: {
        queryText,
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
