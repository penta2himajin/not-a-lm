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
 * Transformers.js / ONNX). We rerank against the chunk KEY (the trigger
 * context), consistent with retrieval.
 */

export const RERANK_MODEL_ID = "Xenova/bge-reranker-base";
export const RERANK_MODEL_LABEL = "bge-reranker-base";

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
    // NOTE: fp32 is required. The q8/int8 quantized ONNX of this model is
    // numerically unstable in onnxruntime-node — it returns non-deterministic
    // scores for identical inputs (e.g. 0.07, 0.07, then 0.99) and spurious
    // high matches. fp32 is deterministic and correctly ranked. (fp16 is
    // unsupported on CPU here.) Trade-off: larger one-time model download.
    model = (await AutoModelForSequenceClassification.from_pretrained(
      RERANK_MODEL_ID,
      { dtype: "fp32", device: "cpu", progress_callback },
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
