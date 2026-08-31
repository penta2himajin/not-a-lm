/**
 * Embedding q8 determinism + quality eval for paraphrase-multilingual-MiniLM-L12-v2.
 * Run: node scripts/eval-embed-q8.mjs [fp32|q8|q4 ...]
 */
const DTYPES = process.argv.slice(2);
if (!DTYPES.length) DTYPES.push("fp32", "q8");

const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

const DETERMINISM_TEXTS = [
  "あなたは誰？",
  "How does this work?",
  "你是谁？",
  "こんにちは",
  "What do you mean by KV?",
  "動作原理と既存の似た手法は？",
];

const CROSS_LANG = [
  ["あなたは誰？", "Who are you?", "你是谁？"],
];

const TOPIC_SEP = [
  ["ja", "あなたは誰？", "こんにちは"],
  ["ja", "あなたは誰？", "仕組みを教えて"],
  ["en", "Who are you?", "Hello there"],
  ["en", "Who are you?", "How does this work?"],
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

function vecKey(v) {
  return Array.from(v)
    .slice(0, 8)
    .map((x) => x.toFixed(6))
    .join(",");
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function tensorToRows(out, expected) {
  if (out.tolist) {
    const list = out.tolist();
    if (Array.isArray(list[0])) {
      return list.map((row) => new Float32Array(row));
    }
    return [new Float32Array(list)];
  }
  if (out.data && out.dims) {
    const data =
      out.data instanceof Float32Array
        ? out.data
        : new Float32Array(out.data);
    const [rows, dim] = out.dims.length === 1 ? [1, out.dims[0]] : out.dims;
    const result = [];
    for (let r = 0; r < rows; r++) {
      result.push(data.slice(r * dim, (r + 1) * dim));
    }
    return result.length ? result : [data.slice()];
  }
  throw new Error("unexpected tensor");
}

async function loadPipe(dtype) {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = process.env.EMBED_CACHE_DIR || "/tmp/notalm-embed-cache";
  return pipeline("feature-extraction", MODEL_ID, {
    dtype,
    device: "cpu",
  });
}

async function embed(pipe, text) {
  const out = await pipe(text, { pooling: "mean", normalize: true });
  return tensorToRows(out, 1)[0];
}

async function embedBatch(pipe, texts) {
  const out = await pipe(texts, { pooling: "mean", normalize: true });
  return tensorToRows(out, texts.length);
}

async function evalDtype(dtype) {
  console.log(`\n=== ${dtype} ===`);
  const pipe = await loadPipe(dtype);

  // 1) Repeated single-text determinism
  let detFail = 0;
  for (const text of DETERMINISM_TEXTS) {
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await embed(pipe, text));
    const keys = [...new Set(runs.map(vecKey))];
    const maxDiff = runs.slice(1).reduce((m, r) => Math.max(m, maxAbsDiff(r, runs[0])), 0);
    const ok = keys.length === 1;
    if (!ok) detFail++;
    console.log(
      `  repeat "${text.slice(0, 24)}" ${ok ? "DET" : "NONDET"} maxDiff=${maxDiff.toExponential(2)} keys=${keys.length}`,
    );
  }

  // 2) Batch vs single consistency (embedMany path)
  let batchFail = 0;
  for (const text of DETERMINISM_TEXTS.slice(0, 3)) {
    const single = await embed(pipe, text);
    const [batched] = await embedBatch(pipe, [text]);
    const diff = maxAbsDiff(single, batched);
    const cos = cosine(single, batched);
    const ok = diff < 1e-5;
    if (!ok) batchFail++;
    console.log(
      `  batch≡single "${text.slice(0, 20)}" ${ok ? "OK" : "MISMATCH"} cos=${cos.toFixed(6)} maxDiff=${diff.toExponential(2)}`,
    );
  }

  // 3) Cross-language alignment
  const [ja, en, zh] = CROSS_LANG[0];
  const [vJa, vEn, vZh] = await Promise.all([
    embed(pipe, ja),
    embed(pipe, en),
    embed(pipe, zh),
  ]);
  const crossJaEn = cosine(vJa, vEn);
  const crossJaZh = cosine(vJa, vZh);
  const crossEnZh = cosine(vEn, vZh);
  console.log(
    `  cross-lang cos: ja-en=${crossJaEn.toFixed(3)} ja-zh=${crossJaZh.toFixed(3)} en-zh=${crossEnZh.toFixed(3)}`,
  );

  // 4) Topic separation
  const sep = [];
  for (const [lang, a, b] of TOPIC_SEP) {
    const [va, vb] = await Promise.all([embed(pipe, a), embed(pipe, b)]);
    sep.push(cosine(va, vb));
  }
  console.log(
    `  topic-sep cos: ${sep.map((s) => s.toFixed(3)).join(" / ")} (lower=better)`,
  );

  return {
    dtype,
    detFail,
    batchFail,
    crossJaEn,
    crossJaZh,
    crossEnZh,
    topicSep: sep,
  };
}

async function main() {
  const results = [];
  for (const dtype of DTYPES) {
    results.push(await evalDtype(dtype));
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(
      `${r.dtype}: detFail=${r.detFail} batchFail=${r.batchFail} cross=${r.crossJaEn.toFixed(3)}/${r.crossJaZh.toFixed(3)}/${r.crossEnZh.toFixed(3)} sep=${r.topicSep.map((s) => s.toFixed(3)).join("/")}`,
    );
  }

  if (results.length === 2) {
    const [fp32, q8] = results;
    const crossDelta = Math.max(
      Math.abs(fp32.crossJaEn - q8.crossJaEn),
      Math.abs(fp32.crossJaZh - q8.crossJaZh),
      Math.abs(fp32.crossEnZh - q8.crossEnZh),
    );
    const sepDelta = Math.max(
      ...fp32.topicSep.map((s, i) => Math.abs(s - q8.topicSep[i])),
    );
    console.log(`\nfp32↔q8 delta: cross≤${crossDelta.toFixed(4)} sep≤${sepDelta.toFixed(4)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
