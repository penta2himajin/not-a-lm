/**
 * Reranker gate/fusion eval — compares cross-encoder models on the NOT A LM corpus.
 * Run: node scripts/eval-reranker.mjs [modelId ...]
 * Default models: Xenova/bge-reranker-base, SugoLabs/mmarco-mMiniLMv2-L12-H384-v1
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const tsconfig = require("../tsconfig.json");
const paths = tsconfig.compilerOptions?.paths ?? {};
const baseUrl = new URL("..", import.meta.url);

async function importTs(rel) {
  const spec = pathToFileURL(new URL(rel, baseUrl).pathname).href;
  return import(spec);
}

const DEFAULT_MODELS = [
  "Xenova/bge-reranker-base",
  "SugoLabs/mmarco-mMiniLMv2-L12-H384-v1",
];

const GATE_CANDIDATES = 3;
const GATE_MIN_SCORE = 0.03;
const FUSE_MIN = 0.5;

/** In-corpus paraphrase queries (3 langs × 15 topics ≈ docs benchmark). */
const IN_CORPUS = [
  // ja
  { lang: "ja", query: "あなたは誰？", expectClaim: "who-1" },
  { lang: "ja", query: "仕組みを教えて", expectClaim: "mech-1" },
  { lang: "ja", query: "KVキャッシュって何？", expectClaim: "var-attention" },
  { lang: "ja", query: "コード書ける？", expectClaim: "code-1" },
  { lang: "ja", query: "こんにちは", expectClaim: "greet-intro" },
  { lang: "ja", query: "動作原理と既存の似た手法は？", expectClaim: "mech-1", fusion: true },
  // en
  { lang: "en", query: "Who are you?", expectClaim: "who-1" },
  { lang: "en", query: "How does this work?", expectClaim: "mech-1" },
  { lang: "en", query: "What do you mean by KV?", expectClaim: "var-attention" },
  { lang: "en", query: "Can you write code?", expectClaim: "code-1" },
  { lang: "en", query: "Hello there", expectClaim: "greet-intro" },
  { lang: "en", query: "Explain the mechanism and the prior art", expectClaim: "mech-1", fusion: true },
  // zh
  { lang: "zh", query: "你是谁？", expectClaim: "who-1" },
  { lang: "zh", query: "工作原理是什么？", expectClaim: "mech-1" },
  { lang: "zh", query: "KV缓存是什么？", expectClaim: "var-attention" },
  { lang: "zh", query: "你会写代码吗？", expectClaim: "code-1" },
  { lang: "zh", query: "你好", expectClaim: "greet-intro" },
  { lang: "zh", query: "讲讲原理和已有的类似方法", expectClaim: "mech-1", fusion: true },
];

/** Out-of-corpus queries (4 per language from docs). */
const OOC = [
  { lang: "ja", query: "今日の天気は？" },
  { lang: "ja", query: "東京タワーの高さは？" },
  { lang: "ja", query: "おすすめの映画は？" },
  { lang: "ja", query: "Pythonのリスト内包表記を教えて" },
  { lang: "en", query: "What's the weather today?" },
  { lang: "en", query: "How tall is the Eiffel Tower?" },
  { lang: "en", query: "Recommend a good movie" },
  { lang: "en", query: "Explain Python list comprehensions" },
  { lang: "zh", query: "今天天气怎么样？" },
  { lang: "zh", query: "埃菲尔铁塔有多高？" },
  { lang: "zh", query: "推荐一部好电影" },
  { lang: "zh", query: "解释一下Python列表推导式" },
];

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

async function loadReranker(modelId) {
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import(
    "@huggingface/transformers"
  );
  env.allowLocalModels = false;
  env.cacheDir = process.env.EMBED_CACHE_DIR || "/tmp/notalm-embed-cache";

  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await AutoModelForSequenceClassification.from_pretrained(modelId, {
    dtype: "fp32",
    device: "cpu",
  });
  return { tokenizer, model };
}

async function scorePairs(reranker, query, keys) {
  const scores = [];
  for (const key of keys) {
    const inputs = await reranker.tokenizer([query], {
      text_pair: [key],
      padding: true,
      truncation: true,
    });
    const { logits } = await reranker.model(inputs);
    const rows = logits.tolist();
    const val = Array.isArray(rows[0]) ? rows[0][0] : rows[0];
    scores.push(sigmoid(val));
  }
  return scores;
}

async function evalModel(modelId, corpus) {
  console.log(`\n=== ${modelId} ===`);
  const t0 = Date.now();
  const reranker = await loadReranker(modelId);
  console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const byLang = (lang) => corpus.filter((c) => c.lang === lang);

  let gatePass = 0;
  let gateTotal = 0;
  const gateScores = { in: [], ooc: [] };
  const gateFails = [];

  for (const lang of ["ja", "en", "zh"]) {
    const chunks = byLang(lang);
    const keys = chunks.map((c) => c.key);

    for (const tc of IN_CORPUS.filter((t) => t.lang === lang && !t.fusion)) {
      const target = chunks.find((c) => c.claim === tc.expectClaim);
      if (!target) continue;
      // Simulate bi-encoder putting target in top-3 (gate only sees keyword keys)
      const topKeys = [target.key, keys[0], keys[1]].filter(
        (k, i, a) => a.indexOf(k) === i,
      );
      const scores = await scorePairs(reranker, tc.query, topKeys.slice(0, GATE_CANDIDATES));
      const max = Math.max(...scores);
      gateScores.in.push(max);
      gateTotal++;
      const ok = max >= GATE_MIN_SCORE;
      if (ok) gatePass++;
      else gateFails.push({ kind: "in", lang, query: tc.query, max });
    }

    for (const tc of OOC.filter((t) => t.lang === lang)) {
      const topKeys = keys.slice(0, GATE_CANDIDATES);
      const scores = await scorePairs(reranker, tc.query, topKeys);
      const max = Math.max(...scores);
      gateScores.ooc.push(max);
      gateTotal++;
      const ok = max < GATE_MIN_SCORE;
      if (ok) gatePass++;
      else gateFails.push({ kind: "ooc", lang, query: tc.query, max });
    }
  }

  const inMin = Math.min(...gateScores.in);
  const inMax = Math.max(...gateScores.in);
  const oocMin = Math.min(...gateScores.ooc);
  const oocMax = Math.max(...gateScores.ooc);

  console.log(
    `gate (${GATE_MIN_SCORE}): ${gatePass}/${gateTotal} correct | in [${inMin.toFixed(3)}, ${inMax.toFixed(3)}] ooc [${oocMin.toFixed(3)}, ${oocMax.toFixed(3)}]`,
  );
  if (gateFails.length) {
    for (const f of gateFails) {
      console.log(`  gate FAIL ${f.kind} ${f.lang} max=${f.max.toFixed(3)} "${f.query}"`);
    }
  }

  // Fusion: segment × candidate scoring for compound queries
  let fusionPass = 0;
  let fusionTotal = 0;
  for (const tc of IN_CORPUS.filter((t) => t.fusion)) {
    const chunks = byLang(tc.lang);
    const keys = chunks.map((c) => c.key);
    const segments =
      tc.lang === "ja"
        ? ["動作原理", "既存の似た手法"]
        : tc.lang === "en"
          ? ["the mechanism", "the prior art"]
          : ["原理", "已有的类似方法"];
    const expectClaims =
      tc.lang === "ja"
        ? ["mech-1", "mech-existing"]
        : tc.lang === "en"
          ? ["mech-1", "mech-existing"]
          : ["mech-1", "mech-existing"];

    const cands = chunks.slice(0, 12);
    const rr = [];
    for (const seg of segments) {
      rr.push(
        await scorePairs(
          reranker,
          seg,
          cands.map((c) => c.key),
        ),
      );
    }

    const pairs = [];
    for (let i = 0; i < segments.length; i++) {
      for (let j = 0; j < cands.length; j++) pairs.push({ i, j, s: rr[i][j] });
    }
    pairs.sort((a, b) => b.s - a.s);
    const usedSeg = new Set();
    const usedCand = new Set();
    const assign = new Map();
    for (const p of pairs) {
      if (p.s < FUSE_MIN) break;
      if (usedSeg.has(p.i) || usedCand.has(p.j)) continue;
      assign.set(p.i, p.j);
      usedSeg.add(p.i);
      usedCand.add(p.j);
    }

    const matched = [...assign.entries()].map(([i, j]) => ({
      seg: segments[i],
      claim: cands[j].claim,
      score: rr[i][j],
    }));
    fusionTotal++;
    const ok =
      matched.length >= 2 &&
      expectClaims.every((claim) => matched.some((m) => m.claim === claim));
    if (ok) fusionPass++;
    console.log(
      `  fusion ${tc.lang}: ${ok ? "OK" : "FAIL"} ${JSON.stringify(matched.map((m) => `${m.claim}@${m.score.toFixed(2)}`))}`,
    );
  }

  console.log(`fusion (${FUSE_MIN}): ${fusionPass}/${fusionTotal}`);

  return {
    modelId,
    gatePass,
    gateTotal,
    gateScores,
    fusionPass,
    fusionTotal,
  };
}

async function main() {
  const models = process.argv.slice(2);
  if (models.length === 0) models.push(...DEFAULT_MODELS);

  const { CHUNK_CORPUS } = await importTs("src/lib/notalm/corpus.ts");
  const results = [];
  for (const modelId of models) {
    results.push(await evalModel(modelId, CHUNK_CORPUS));
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(
      `${r.modelId}: gate ${r.gatePass}/${r.gateTotal}, fusion ${r.fusionPass}/${r.fusionTotal}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
