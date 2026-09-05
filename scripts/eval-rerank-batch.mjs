/**
 * CE batch ≡ single regression (+ dtype matrix).
 *
 * Documents that pad-to-longest batching is exact on fp32 and unsafe on q8
 * for Xenova/bge-reranker-base via Transformers.js ONNX.
 *
 * Run: node --experimental-strip-types scripts/eval-rerank-batch.mjs
 * Optional: RERANK_DTYPE=fp32 node ...
 */
import { writeFileSync } from "node:fs";
import { CHUNK_CORPUS } from "../src/lib/notalm/corpus.ts";
import {
  loadReranker,
  rerankScoresBatched,
  rerankScoresSequential,
  RERANK_DTYPE,
  RERANK_MODEL_ID,
} from "../src/lib/notalm/rerank.ts";

const ABS_EPS = Number(process.env.RERANK_BATCH_EPS || "1e-5");
const GATE_MIN = 0.03;
const FUSE_MIN = 0.5;

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function keysForLang(lang, n = 12) {
  return CHUNK_CORPUS.filter((c) => c.lang === lang && c.speaker === "bot")
    .slice(0, n)
    .map((c) => c.key);
}

const CASES = [
  { name: "gate-ja-who", query: "お前誰？", cands: keysForLang("ja", 4) },
  { name: "gate-en-who", query: "Who are you?", cands: keysForLang("en", 4) },
  { name: "gate-zh-who", query: "你是谁？", cands: keysForLang("zh", 4) },
  { name: "fuse-ja-12", query: "RAGで生成しているの", cands: keysForLang("ja", 12) },
  { name: "fuse-en-12", query: "existing similar systems", cands: keysForLang("en", 12) },
  {
    name: "mixed-lengths",
    query: "仕組み教えて",
    cands: [
      "仕組み",
      "how does it work mechanism",
      ...keysForLang("ja", 5),
      "埋め込み 近傍 検索 チャンク KV 返答 生成しない",
    ],
  },
];

await loadReranker((m) => {
  if (/ready|失敗|error/i.test(m) || m.includes("%") === false) console.log(" ", m);
});
console.log(`model=${RERANK_MODEL_ID} dtype=${RERANK_DTYPE} eps=${ABS_EPS}`);

let fail = 0;
const report = [];

for (const c of CASES) {
  const t1 = performance.now();
  const single = await rerankScoresSequential(c.query, c.cands);
  const singleMs = Math.round(performance.now() - t1);

  const t2 = performance.now();
  const batched = await rerankScoresBatched(c.query, c.cands);
  const batchMs = Math.round(performance.now() - t2);

  const diff = maxAbsDiff(single, batched);
  const gateFlip =
    Math.max(...single) >= GATE_MIN !== Math.max(...batched) >= GATE_MIN;
  const fuseFlip = single.some(
    (s, i) => s >= FUSE_MIN !== batched[i] >= FUSE_MIN,
  );
  const ok = diff <= ABS_EPS && !gateFlip && !fuseFlip;
  if (!ok) fail++;

  const row = {
    name: c.name,
    n: c.cands.length,
    maxAbsDiff: diff,
    gateFlip,
    fuseFlip,
    singleMs,
    batchMs,
    speedup: singleMs / Math.max(1, batchMs),
    ok,
  };
  report.push(row);
  console.log(
    `${ok ? "OK" : "FAIL"} ${c.name} n=${c.cands.length} maxDiff=${diff.toExponential(2)} ` +
      `gateFlip=${gateFlip} fuseFlip=${fuseFlip} ` +
      `single=${singleMs}ms batch=${batchMs}ms ×${row.speedup.toFixed(2)}`,
  );
}

// Pad-alone sensitivity (single sequence forced longer)
{
  const q = "RAGで生成しているの";
  const target = keysForLang("ja", 12)[3];
  const natural = await rerankScoresSequential(q, [target]);
  // Batch with a much longer neighbor forces pad on the short target row
  const long =
    keysForLang("ja", 30).reduce((a, b) => (a.length >= b.length ? a : b)) ||
    target;
  const withLong = await rerankScoresBatched(q, [target, long]);
  const diff = Math.abs(natural[0] - withLong[0]);
  // For fp32 expect ~0; for q8 expect large — report only, don't fail suite on q8
  console.log(
    `INFO pad-with-neighbor targetDiff=${diff.toExponential(2)} ` +
      `(dtype=${RERANK_DTYPE}; fp32 should be ~0, q8 often large)`,
  );
  report.push({ name: "pad-with-neighbor", maxAbsDiff: diff, dtype: RERANK_DTYPE });
}

writeFileSync(
  "/opt/cursor/artifacts/ce_batch_eval.json",
  JSON.stringify(
    { model: RERANK_MODEL_ID, dtype: RERANK_DTYPE, absEps: ABS_EPS, fail, report },
    null,
    2,
  ),
);

const expectPass = RERANK_DTYPE === "fp32";
if (expectPass && fail) {
  console.log(`\nrerank-batch: EXPECTED PASS for fp32 but fail=${fail}`);
  process.exit(1);
}
if (!expectPass) {
  console.log(
    `\nrerank-batch: dtype=${RERANK_DTYPE} — pad-batch mismatches are expected; fail=${fail}/${CASES.length}`,
  );
  // Non-fp32: exit 0 after documenting failures (investigation mode).
  process.exit(0);
}
console.log(`\nrerank-batch: ${CASES.length - fail}/${CASES.length} (fp32)`);
process.exit(fail ? 1 : 0);
