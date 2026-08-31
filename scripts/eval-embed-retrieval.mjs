/**
 * Corpus top-1 retrieval accuracy: fp32 vs q8 embeddings on natKey.
 * Run: node scripts/eval-embed-retrieval.mjs
 */

const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

const CASES = [
  { lang: "ja", query: "あなたは誰？", claim: "who-1" },
  { lang: "ja", query: "仕組みを教えて", claim: "mech-1" },
  { lang: "ja", query: "KVキャッシュって何？", claim: "var-attention" },
  { lang: "ja", query: "コード書ける？", claim: "code-1" },
  { lang: "ja", query: "こんにちは", claim: "greet-intro" },
  { lang: "en", query: "Who are you?", claim: "who-1" },
  { lang: "en", query: "How does this work?", claim: "mech-1" },
  { lang: "en", query: "What do you mean by KV?", claim: "var-attention" },
  { lang: "en", query: "Can you write code?", claim: "code-1" },
  { lang: "en", query: "Hello there", claim: "greet-intro" },
  { lang: "zh", query: "你是谁？", claim: "who-1" },
  { lang: "zh", query: "工作原理是什么？", claim: "mech-1" },
  { lang: "zh", query: "KV缓存是什么？", claim: "var-attention" },
  { lang: "zh", query: "你会写代码吗？", claim: "code-1" },
  { lang: "zh", query: "你好", claim: "greet-intro" },
];

function cosine(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function tensorToRows(out, expected) {
  if (out.tolist) {
    const list = out.tolist();
    if (Array.isArray(list[0])) return list.map((r) => new Float32Array(r));
    return [new Float32Array(list)];
  }
  const data =
    out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
  const [rows, dim] = out.dims.length === 1 ? [1, out.dims[0]] : out.dims;
  const result = [];
  for (let r = 0; r < rows; r++) result.push(data.slice(r * dim, (r + 1) * dim));
  return result;
}

async function evalDtype(dtype, corpus) {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = "/tmp/notalm-embed-cache";
  const pipe = await pipeline("feature-extraction", MODEL_ID, {
    dtype,
    device: "cpu",
  });

  const botChunks = corpus.filter((c) => c.speaker === "bot");
  const texts = botChunks.map((c) => c.natKey);
  const vecs = [];
  const batchSize = 8;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const out = await pipe(batch, { pooling: "mean", normalize: true });
    vecs.push(...tensorToRows(out, batch.length));
  }
  const index = botChunks.map((c, i) => ({ ...c, emb: vecs[i] }));

  let ok = 0;
  const fails = [];
  for (const tc of CASES) {
    const out = await pipe(tc.query, { pooling: "mean", normalize: true });
    const qv = tensorToRows(out, 1)[0];
    const ranked = index
      .filter((c) => c.lang === tc.lang)
      .map((c) => ({ claim: c.claim, cos: cosine(qv, c.emb) }))
      .sort((a, b) => b.cos - a.cos);
    const top = ranked[0];
    const pass = top.claim === tc.claim;
    if (pass) ok++;
    else fails.push({ ...tc, got: top.claim, cos: top.cos });
  }
  return { dtype, ok, total: CASES.length, fails };
}

async function main() {
  const base = new URL("..", import.meta.url);
  const { CHUNK_CORPUS } = await import(
    new URL("src/lib/notalm/corpus.ts", base).href
  );
  const results = [];
  for (const dtype of ["fp32", "q8"]) {
    const r = await evalDtype(dtype, CHUNK_CORPUS);
    results.push(r);
    console.log(`${dtype}: top-1 ${r.ok}/${r.total}`);
    if (r.fails.length) console.log("  fails:", r.fails);
  }

  const fp32Only = results[0].fails.filter(
    (f) => !results[1].fails.some((g) => g.query === f.query),
  );
  const q8Only = results[1].fails.filter(
    (f) => !results[0].fails.some((g) => g.query === f.query),
  );
  console.log("\nregressions q8 vs fp32:", q8Only.length ? q8Only : "none");
  console.log("fixed by q8:", fp32Only.length ? fp32Only : "none");
}

main().catch(console.error);
