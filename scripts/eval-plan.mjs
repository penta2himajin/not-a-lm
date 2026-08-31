/**
 * G5 operation plan unit eval (render + derive label).
 * Run: node --experimental-strip-types scripts/eval-plan.mjs
 */
import {
  deriveOperationLabel,
  fusedWithFromPlan,
  formatOperationPlan,
  formatOpStep,
  planFuseParts,
  renderOperationPlan,
  GROUNDED_OPENERS,
} from "../src/lib/notalm/plan.ts";
import { CHUNK_CORPUS } from "../src/lib/notalm/corpus.ts";
import { loadDense } from "../src/lib/notalm/embed.ts";
import { loadNli } from "../src/lib/notalm/nli.ts";

function chunk(claim, lang) {
  return CHUNK_CORPUS.find((c) => c.claim === claim && c.lang === lang);
}

let pass = 0;
let total = 0;

function check(name, ok, detail = "") {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? " " + detail : ""}`);
}

// derive labels
{
  const p = {
    steps: [
      { kind: "prefix", which: "negate-correct" },
      { kind: "body", chunkId: "x" },
    ],
    reasons: [],
  };
  check("derive negate", deriveOperationLabel(p) === "negate-correct");
}
{
  const c = chunk("mech-rag-a", "ja");
  const p = {
    steps: [
      {
        kind: "body",
        chunkId: c.id,
        composePlan: {
          prefix: "negate-correct",
          kept: [{ chunkId: c.id, spanId: "no-gen" }],
        },
      },
    ],
    reasons: [],
  };
  check("derive compose", deriveOperationLabel(p) === "compose");
}
{
  const a = chunk("mech-1", "ja");
  const b = chunk("mech-existing", "ja");
  const p = {
    steps: [
      { kind: "body", chunkId: a.id },
      { kind: "glue", template: "topic", topic: "既存手法" },
      { kind: "body", chunkId: b.id, stripFiller: true },
    ],
    reasons: [],
  };
  check("derive fuse", deriveOperationLabel(p) === "fuse");
  check("fusedWith", fusedWithFromPlan(p) === b.id);
}

// render: G2 legacy negate
{
  const c = chunk("code-bug-a", "ja");
  const p = {
    steps: [
      { kind: "prefix", which: "negate-correct" },
      { kind: "body", chunkId: c.id },
    ],
    reasons: ["test"],
  };
  const text = renderOperationPlan(
    p,
    (id) => CHUNK_CORPUS.find((x) => x.id === id),
    "ja",
    GROUNDED_OPENERS,
  );
  check(
    "render G2 negate",
    text.startsWith("いいえ、そうではありません。") &&
      text.includes("直せない"),
    text.slice(0, 40),
  );
}

// render: compose body with prefix inside ComposePlan
{
  const c = chunk("mech-rag-a", "ja");
  const noGen = c.spans.find((s) => s.id === "no-gen");
  const p = {
    steps: [
      {
        kind: "body",
        chunkId: c.id,
        composePlan: {
          prefix: "negate-correct",
          kept: [{ chunkId: c.id, spanId: "no-gen" }],
        },
      },
    ],
    reasons: [],
  };
  const text = renderOperationPlan(
    p,
    (id) => CHUNK_CORPUS.find((x) => x.id === id),
    "ja",
    GROUNDED_OPENERS,
  );
  check(
    "render compose+prefix",
    text.startsWith("いいえ、そうではありません。") &&
      text.includes(noGen.text) &&
      !text.includes("近い。"),
  );
}

// render: fuse with topic glue + strip filler
{
  const a = chunk("mech-1", "ja");
  const b = chunk("mech-existing", "ja");
  const p = {
    steps: [
      { kind: "body", chunkId: a.id },
      { kind: "glue", template: "topic", topic: "既存の似た手法" },
      { kind: "body", chunkId: b.id, stripFiller: true },
    ],
    reasons: [],
  };
  const text = renderOperationPlan(
    p,
    (id) => CHUNK_CORPUS.find((x) => x.id === id),
    "ja",
    GROUNDED_OPENERS,
  );
  check(
    "render fuse glue",
    text.includes(a.value) &&
      text.includes("既存の似た手法については、") &&
      text.includes("retrieval-only") &&
      !text.includes("あるよ。retrieval"),
    text.slice(0, 80),
  );
}

// format helpers (G5b)
{
  const s = formatOpStep({
    kind: "prefix",
    which: "negate-correct",
  });
  check("format ¬", s === "¬");
  const g = formatOpStep({
    kind: "glue",
    template: "topic",
    topic: "既存手法",
  });
  check("format glue", g === "glue(既存手法)");
}

async function g5c() {
  console.log("\nLoading dense+NLI for G5c polarity×fuse…");
  await loadDense(() => {});
  await loadNli(() => {});

  const rag = chunk("mech-rag-a", "ja");
  const prior = chunk("mech-existing", "ja");
  const parts = [
    { seg: "RAGで生成している", chunk: rag },
    { seg: "既存の似た手法", chunk: prior },
  ];
  const out = await planFuseParts(parts, "ja");
  if (!out) {
    check("g5c planFuseParts", false, "null plan");
    return;
  }
  const { plan } = out;
  check("g5c derive fuse", deriveOperationLabel(plan) === "fuse");
  check(
    "g5c has glue",
    plan.steps.some((s) => s.kind === "glue"),
  );
  const hasNeg =
    plan.steps.some(
      (s) => s.kind === "prefix" && s.which === "negate-correct",
    ) ||
    plan.steps.some(
      (s) =>
        s.kind === "body" && s.composePlan?.prefix === "negate-correct",
    );
  check("g5c polarity on RAG part", hasNeg, formatOperationPlan(plan));
  const text = renderOperationPlan(
    plan,
    (id) => CHUNK_CORPUS.find((x) => x.id === id),
    "ja",
    GROUNDED_OPENERS,
  );
  check(
    "g5c render negate+fuse",
    text.includes("いいえ、そうではありません。") &&
      text.includes("既存の似た手法については、") &&
      (text.includes("生成段がなく") || text.includes("回収＝返答")),
    text.slice(0, 100),
  );
}

await g5c();

console.log(`\nplan: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
