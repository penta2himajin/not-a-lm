/**
 * Cross-encoder reranker (stage 2) for NOT A LM.
 *
 * The bi-encoder (embed.ts) is fast but topically fuzzy: semantically adjacent
 * chunks (e.g. "how do you operate" vs "what do you do on sunny days") can be
 * confused. A cross-encoder jointly encodes (query, candidate-key) and scores
 * relevance directly, which sharply improves selection precision — especially
 * for Chinese paraphrases — and yields a well-separated score we use as a
 * confidence signal (see engine.ts confidence gate).
 *
 * Model: Xenova/bge-reranker-base (multilingual XLM-RoBERTa cross-encoder,
 * Transformers.js / ONNX). Default dtype is q8 (~280MB ONNX vs ~1.1GB fp32).
 * Override with RERANK_MODEL_ID / RERANK_DTYPE. Smaller multilingual
 * cross-encoders (e.g. mmarco-mMiniLMv2) were evaluated and rejected — see
 * docs/reranker-model-selection.md.
 */

export const RERANK_MODEL_ID =
  process.env.RERANK_MODEL_ID ?? "Xenova/bge-reranker-base";
export const RERANK_MODEL_LABEL =
  process.env.RERANK_MODEL_LABEL ?? "bge-reranker-base";
/** fp32 | q8 | q4 — q8 cuts ONNX from ~1.1GB to ~280MB; re-validated deterministic on v4.2.0 */
export const RERANK_DTYPE = process.env.RERANK_DTYPE ?? "q8";

type Tokenizer = (
  text: string[],
  options: { text_pair: string[]; padding: boolean; truncation: boolean },
) => Promise<Record<string, unknown>>;

type SeqClsModel = (
  inputs: Record<string, unknown>,
) => Promise<{ logits: { tolist: () => number[][] | number[] } }>;

let tokenizer: Tokenizer | null = null;
let model: SeqClsModel | null = null;
let loading: Promise<void> | null = null;
let lastProgress = "idle";

export function getRerankerProgress(): string {
  return lastProgress;
}

export function isRerankerReady(): boolean {
  return tokenizer != null && model != null;
}

export async function loadReranker(
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (isRerankerReady()) return;
  if (loading) return loading;

  loading = (async () => {
    const report = (msg: string) => {
      lastProgress = msg;
      onProgress?.(msg);
    };

    report("リランカー読込中…");
    const { AutoTokenizer, AutoModelForSequenceClassification, env } =
      await import("@huggingface/transformers");
    env.allowLocalModels = false;
    if (typeof process !== "undefined") {
      env.cacheDir =
        process.env.EMBED_CACHE_DIR ||
        process.env.BEKKO_CACHE_DIR ||
        "/tmp/notalm-embed-cache";
    }

    report(`${RERANK_MODEL_ID} を取得中…`);
    const progress_callback = (p: {
      status?: string;
      progress?: number;
      file?: string;
    }) => {
      if (p?.status === "progress" && p.progress != null && p.file) {
        report(`${p.file} ${Math.round(p.progress)}%`);
      } else if (p?.status) {
        report(String(p.status));
      }
    };

    tokenizer = (await AutoTokenizer.from_pretrained(RERANK_MODEL_ID, {
      progress_callback,
    })) as unknown as Tokenizer;
    // q8 (~280MB) is the default: much smaller than fp32 (~1.1GB) and
    // deterministic on @huggingface/transformers 4.2.0 / onnxruntime-node in
    // our gate+fusion eval (the older fp32-only note predates this re-check).
    // Override with RERANK_DTYPE=fp32 if needed.
    model = (await AutoModelForSequenceClassification.from_pretrained(
      RERANK_MODEL_ID,
      { dtype: RERANK_DTYPE, device: "cpu", progress_callback },
    )) as unknown as SeqClsModel;

    report(`${RERANK_MODEL_LABEL} ready`);
  })();

  try {
    await loading;
  } catch (e) {
    loading = null;
    tokenizer = null;
    model = null;
    lastProgress = e instanceof Error ? e.message : "reranker load failed";
    throw e;
  }
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Score each candidate against the query with the cross-encoder.
 * Returns a relevance probability in [0,1] per candidate (same order).
 * Throws if the reranker is not loaded — callers should check isRerankerReady().
 *
 * IMPORTANT: candidates are scored one pair at a time (batch size 1). Batched
 * inference with padding is not reliable through this ONNX path — padded
 * sequences distort each other's scores, so the same (query, candidate) pair
 * gets different scores depending on batch composition. Scoring per pair keeps
 * results deterministic and correct at the cost of N sequential forwards
 * (N is small — see RERANK_CANDIDATES in engine.ts).
 */
export async function rerankScores(
  query: string,
  candidates: string[],
): Promise<number[]> {
  if (!tokenizer || !model) throw new Error("reranker not ready");
  if (candidates.length === 0) return [];

  const scores: number[] = [];
  for (const candidate of candidates) {
    const inputs = await tokenizer([query], {
      text_pair: [candidate],
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    const rows = logits.tolist();
    const val = Array.isArray(rows[0])
      ? (rows as number[][])[0][0]
      : (rows as number[])[0];
    scores.push(sigmoid(val));
  }
  return scores;
}

function ceCacheKey(query: string, candidateKey: string): string {
  return `${query}\x00${candidateKey}`;
}

/** Per-turn CE scorer: dedupes (query, key) pairs and counts ONNX forwards. */
export type CeScorer = {
  score: (query: string, candidateKeys: string[]) => Promise<number[]>;
  forwardCount: number;
};

export function createCeScorer(): CeScorer {
  const cache = new Map<string, number>();
  const scorer: CeScorer = {
    forwardCount: 0,
    async score(query: string, candidateKeys: string[]) {
      if (candidateKeys.length === 0) return [];
      const out = new Array<number>(candidateKeys.length);
      const missing: { idx: number; key: string }[] = [];
      for (let i = 0; i < candidateKeys.length; i++) {
        const ck = ceCacheKey(query, candidateKeys[i]);
        const hit = cache.get(ck);
        if (hit !== undefined) out[i] = hit;
        else missing.push({ idx: i, key: candidateKeys[i] });
      }
      if (missing.length > 0) {
        const fresh = await rerankScores(
          query,
          missing.map((m) => m.key),
        );
        scorer.forwardCount += fresh.length;
        missing.forEach((m, j) => {
          const ck = ceCacheKey(query, m.key);
          cache.set(ck, fresh[j]);
          out[m.idx] = fresh[j];
        });
      }
      return out;
    },
  };
  return scorer;
}
