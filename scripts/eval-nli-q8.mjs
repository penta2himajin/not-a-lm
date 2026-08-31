/**
 * NLI q8 determinism + grounded-generation quality eval.
 * Run: node scripts/eval-nli-q8.mjs [fp32|q8 ...]
 */
const DTYPES = process.argv.slice(2);
if (!DTYPES.length) DTYPES.push("fp32", "q8");

const MODEL_ID = "onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX";

/** False-presupposition → negate-correct (9 cases from docs) */
const NEGATE_CASES = [
  { lang: "ja", premise: "あなたはRAGで生成しているの？", hypothesis: "あなたはRAGで生成している。", expect: "entail" },
  { lang: "en", premise: "Do you generate with RAG?", hypothesis: "You generate with RAG.", expect: "entail" },
  { lang: "zh", premise: "你是靠 RAG 生成的吗？", hypothesis: "你是靠 RAG 生成的。", expect: "entail" },
  { lang: "ja", premise: "コードを書いて", hypothesis: "あなたはコードを書ける。", expect: "entail" },
  { lang: "en", premise: "Write me some code", hypothesis: "You can write code.", expect: "entail" },
  { lang: "zh", premise: "帮我写点代码", hypothesis: "你能写代码。", expect: "entail" },
  { lang: "ja", premise: "意識はある？", hypothesis: "あなたには意識がある。", expect: "entail" },
  { lang: "en", premise: "Are you conscious?", hypothesis: "You are conscious.", expect: "entail" },
  { lang: "zh", premise: "有意识吗？", hypothesis: "你有意识。", expect: "entail" },
];

/** Neutral how-questions → should NOT entail deny assertions */
const NEUTRAL_CASES = [
  { lang: "ja", premise: "仕組みを教えて", hypothesis: "あなたはRAGで生成している。", expect: "neutral" },
  { lang: "en", premise: "How does this work?", hypothesis: "You generate with RAG.", expect: "neutral" },
  { lang: "zh", premise: "工作原理是什么？", hypothesis: "你是靠 RAG 生成的。", expect: "neutral" },
];

/** Affirm cases */
const AFFIRM_CASES = [
  { lang: "ja", premise: "検索で返答を選んでいるの？", hypothesis: "あなたは検索（近傍探索）で返答を選んでいる。", expect: "entail" },
  { lang: "en", premise: "Do you pick replies by search?", hypothesis: "You pick replies by search (nearest-neighbor).", expect: "entail" },
  { lang: "zh", premise: "你是靠检索来选回复的吗？", hypothesis: "你是靠检索（最近邻）来选回复的。", expect: "entail" },
];

const DETERMINISM_PAIRS = [
  ["あなたはRAGで生成しているの？", "あなたはRAGで生成している。"],
  ["Are you an LLM?", "You are a language model (LLM)."],
  ["有意识吗？", "你有意识。"],
];

function softmax(a) {
  const m = Math.max(...a);
  const e = a.map((x) => Math.exp(x - m));
  const s = e.reduce((p, c) => p + c, 0);
  return e.map((x) => x / s);
}

async function loadNli(dtype) {
  const { AutoTokenizer, AutoModelForSequenceClassification, env } =
    await import("@huggingface/transformers");
  env.cacheDir = process.env.EMBED_CACHE_DIR || "/tmp/notalm-embed-cache";
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, {
    dtype,
    device: "cpu",
  });
  const id2label = model.config?.id2label ?? {
    "0": "entailment",
    "1": "neutral",
    "2": "contradiction",
  };
  return { tokenizer, model, id2label };
}

async function classify(nli, premise, hypothesis) {
  const inputs = await nli.tokenizer(premise, {
    text_pair: hypothesis,
    padding: true,
    truncation: true,
  });
  const { logits } = await nli.model(inputs);
  const rows = logits.tolist();
  const row = Array.isArray(rows[0]) ? rows[0] : rows;
  const probs = softmax(row);

  let entailIdx = -1;
  for (const [idx, label] of Object.entries(nli.id2label)) {
    if (String(label).toLowerCase().includes("entail")) entailIdx = Number(idx);
  }
  const entail = entailIdx >= 0 ? probs[entailIdx] : 0;

  let topI = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[topI]) topI = i;
  const label = String(nli.id2label[String(topI)] ?? topI).toLowerCase();

  return { label, entail, top: probs[topI] };
}

function labelKind(label) {
  if (label.includes("entail")) return "entail";
  if (label.includes("contrad")) return "contradiction";
  return "neutral";
}

async function evalDtype(dtype) {
  console.log(`\n=== ${dtype} ===`);
  const nli = await loadNli(dtype);

  let detFail = 0;
  for (const [premise, hypothesis] of DETERMINISM_PAIRS) {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const r = await classify(nli, premise, hypothesis);
      runs.push(`${r.label}@${r.entail.toFixed(4)}`);
    }
    const uniq = [...new Set(runs)];
    const ok = uniq.length === 1;
    if (!ok) detFail++;
    console.log(`  repeat "${premise.slice(0, 28)}" ${ok ? "DET" : "NONDET"} ${uniq.join(" | ")}`);
  }

  let negateOk = 0;
  const negateFails = [];
  for (const tc of NEGATE_CASES) {
    const r = await classify(nli, tc.premise, tc.hypothesis);
    const kind = labelKind(r.label);
    const pass = kind === "entail" && r.entail >= 0.5;
    if (pass) negateOk++;
    else negateFails.push({ ...tc, got: kind, entail: r.entail });
  }
  console.log(`  negate-correct: ${negateOk}/${NEGATE_CASES.length}`);
  if (negateFails.length) console.log("    fails:", negateFails);

  let neutralOk = 0;
  const neutralFails = [];
  for (const tc of NEUTRAL_CASES) {
    const r = await classify(nli, tc.premise, tc.hypothesis);
    const kind = labelKind(r.label);
    const pass = kind !== "entail" || r.entail < 0.5;
    if (pass) neutralOk++;
    else neutralFails.push({ ...tc, got: kind, entail: r.entail });
  }
  console.log(`  neutral (no false negate): ${neutralOk}/${NEUTRAL_CASES.length}`);
  if (neutralFails.length) console.log("    fails:", neutralFails);

  let affirmOk = 0;
  for (const tc of AFFIRM_CASES) {
    const r = await classify(nli, tc.premise, tc.hypothesis);
    const kind = labelKind(r.label);
    if (kind === "entail" && r.entail >= 0.5) affirmOk++;
  }
  console.log(`  affirm: ${affirmOk}/${AFFIRM_CASES.length}`);

  return { dtype, detFail, negateOk, neutralOk, affirmOk, negateFails, neutralFails };
}

async function main() {
  const results = [];
  for (const dtype of DTYPES) results.push(await evalDtype(dtype));

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(
      `${r.dtype}: detFail=${r.detFail} negate=${r.negateOk}/${NEGATE_CASES.length} neutral=${r.neutralOk}/${NEUTRAL_CASES.length} affirm=${r.affirmOk}/${AFFIRM_CASES.length}`,
    );
  }

  if (results.length === 2) {
    const [fp32, q8] = results;
    const regressions = q8.negateFails.filter(
      (f) => !fp32.negateFails.some((g) => g.premise === f.premise),
    );
    const neutralReg = q8.neutralFails.filter(
      (f) => !fp32.neutralFails.some((g) => g.premise === f.premise),
    );
    console.log(`\nq8 regressions vs fp32: negate=${regressions.length} neutral=${neutralReg.length}`);
    if (regressions.length) console.log(regressions);
    if (neutralReg.length) console.log(neutralReg);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
