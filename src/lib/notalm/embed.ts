/**
 * Embedding backends for NOT A LM.
 * Primary: Xenova/paraphrase-multilingual-MiniLM-L12-v2 (multilingual, 384-d,
 *   symmetric similarity; official Transformers.js / ONNX path)
 * Fallback: feature-hashing n-grams while the dense model boots
 */

export type EmbedBackend = "hash" | "dense";

export const DENSE_MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
/** Short label for UI/status; the repo id above is verbose. */
export const DENSE_MODEL_LABEL = "multilingual-MiniLM-L12";
const HASH_DIM = 384;

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function charNgrams(text: string, n: number): string[] {
  const s = text.replace(/\s/g, "");
  if (s.length < n) return s ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i <= s.length - n; i++) out.push(s.slice(i, i + n));
  return out;
}

function wordTokens(text: string): string[] {
  return text.split(" ").filter(Boolean);
}

/** Instant fallback embedder (same dim as the dense model: 384) */
export function hashEmbed(text: string, dim = HASH_DIM): Float32Array {
  const vec = new Float32Array(dim);
  const normed = normalizeText(text);
  if (!normed) return vec;

  const features: string[] = [
    ...wordTokens(normed).map((w) => `w:${w}`),
    ...charNgrams(normed, 2).map((g) => `c2:${g}`),
    ...charNgrams(normed, 3).map((g) => `c3:${g}`),
  ];

  for (const f of features) {
    const h = fnv1a(f);
    const idx = h % dim;
    const sign = h & 1 ? 1 : -1;
    vec[idx] += sign;
  }

  let sumSq = 0;
  for (let i = 0; i < dim; i++) sumSq += vec[i] * vec[i];
  const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 1;
  for (let i = 0; i < dim; i++) vec[i] *= inv;
  return vec;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

type Extractor = (
  texts: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{
  tolist?: () => number[][] | number[];
  data?: Float32Array | number[];
  dims?: number[];
}>;

let densePipe: Extractor | null = null;
let denseLoading: Promise<void> | null = null;
let lastProgress = "idle";

export function getDenseProgress(): string {
  return lastProgress;
}

export function isDenseReady(): boolean {
  return densePipe != null;
}

export async function loadDense(
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (densePipe) return;
  if (denseLoading) return denseLoading;

  denseLoading = (async () => {
    const report = (msg: string) => {
      lastProgress = msg;
      onProgress?.(msg);
    };

    report("Transformers.js 読込中…");
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    // Cache under /tmp in cloud / server
    if (typeof process !== "undefined") {
      env.cacheDir =
        process.env.EMBED_CACHE_DIR ||
        process.env.BEKKO_CACHE_DIR ||
        "/tmp/notalm-embed-cache";
    }

    report(`${DENSE_MODEL_ID} を取得中…`);
    // fp32 is required for determinism: the q8 quantized model is non-
    // deterministic in onnxruntime-node (same text embeds differently across
    // runs), which destabilizes retrieval scores, the confidence gate, and
    // fusion. fp32 costs a larger download but keeps results reproducible.
    densePipe = (await pipeline("feature-extraction", DENSE_MODEL_ID, {
      dtype: "fp32",
      device: "cpu",
      progress_callback: (p: {
        status?: string;
        progress?: number;
        file?: string;
      }) => {
        if (p?.status === "progress" && p.progress != null && p.file) {
          report(`${p.file} ${Math.round(p.progress)}%`);
        } else if (p?.status) {
          report(String(p.status));
        }
      },
    })) as unknown as Extractor;

    report(`${DENSE_MODEL_LABEL} ready`);
  })();

  try {
    await denseLoading;
  } catch (e) {
    denseLoading = null;
    densePipe = null;
    lastProgress = e instanceof Error ? e.message : "dense load failed";
    throw e;
  }
}

function tensorToRows(
  out: Awaited<ReturnType<Extractor>>,
  expected: number,
): Float32Array[] {
  if (out.tolist) {
    const list = out.tolist();
    if (Array.isArray(list[0])) {
      return (list as number[][]).map((row) => new Float32Array(row));
    }
    return [new Float32Array(list as number[])];
  }

  if (out.data && out.dims) {
    const data =
      out.data instanceof Float32Array
        ? out.data
        : new Float32Array(out.data as number[]);
    const dims = out.dims;
    if (dims.length === 1) return [data.slice()];
    const rows = dims[0];
    const dim = dims[1];
    const result: Float32Array[] = [];
    for (let r = 0; r < rows; r++) {
      result.push(data.slice(r * dim, (r + 1) * dim));
    }
    if (result.length !== expected) {
      // single vector case
      return result.length ? result : [data.slice()];
    }
    return result;
  }

  throw new Error("Unexpected embedding tensor shape");
}

export async function embed(
  text: string,
  backend: EmbedBackend,
): Promise<Float32Array> {
  if (backend === "hash" || !densePipe) return hashEmbed(text);

  const out = await densePipe(text, { pooling: "mean", normalize: true });
  return tensorToRows(out, 1)[0];
}

export async function embedMany(
  texts: string[],
  backend: EmbedBackend,
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  if (backend === "hash" || !densePipe) {
    return texts.map((t, i) => {
      onProgress?.(i + 1, texts.length);
      return hashEmbed(t);
    });
  }

  const results: Float32Array[] = [];
  const batchSize = 4;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const out = await densePipe(batch, { pooling: "mean", normalize: true });
    results.push(...tensorToRows(out, batch.length));
    onProgress?.(Math.min(i + batch.length, texts.length), texts.length);
  }
  return results;
}
