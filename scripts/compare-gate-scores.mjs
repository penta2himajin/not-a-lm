/** Compare gate scores for simple vs compound queries across rerankers. */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const baseUrl = new URL("..", import.meta.url);
async function importTs(rel) {
  return import(pathToFileURL(new URL(rel, baseUrl).pathname).href);
}

const MODELS = [
  "Xenova/bge-reranker-base",
  "SugoLabs/mmarco-mMiniLMv2-L12-H384-v1",
];

const QUERIES = [
  { label: "in ja mech", query: "仕組みを教えて", lang: "ja", claim: "mech-1" },
  { label: "in en code", query: "Can you write code?", lang: "en", claim: "code-1" },
  { label: "in en mech", query: "How does this work?", lang: "en", claim: "mech-1" },
  { label: "fuse ja", query: "動作原理と既存の似た手法は？", lang: "ja" },
  { label: "fuse en", query: "Explain the mechanism and the prior art", lang: "en" },
  { label: "fuse zh", query: "讲讲原理和已有的类似方法", lang: "zh" },
  { label: "ooc ja weather", query: "今日の天気は？", lang: "ja" },
];

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

async function load(modelId) {
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import(
    "@huggingface/transformers"
  );
  env.cacheDir = "/tmp/notalm-embed-cache";
  return {
    tokenizer: await AutoTokenizer.from_pretrained(modelId),
    model: await AutoModelForSequenceClassification.from_pretrained(modelId, {
      dtype: "fp32",
      device: "cpu",
    }),
  };
}

async function maxGateScore(r, query, keys) {
  let max = 0;
  for (const key of keys.slice(0, 3)) {
    const inputs = await r.tokenizer([query], {
      text_pair: [key],
      padding: true,
      truncation: true,
    });
    const { logits } = await r.model(inputs);
    const rows = logits.tolist();
    const val = Array.isArray(rows[0]) ? rows[0][0] : rows[0];
    max = Math.max(max, sigmoid(val));
  }
  return max;
}

async function main() {
  const { CHUNK_CORPUS } = await importTs("src/lib/notalm/corpus.ts");
  const { composeQueryVector } = await importTs("src/lib/notalm/query-vector.ts");
  const { embedMany, loadDense } = await importTs("src/lib/notalm/embed.ts");

  await loadDense();
  const vectors = await embedMany(CHUNK_CORPUS.map((c) => c.natKey), "dense");
  const index = CHUNK_CORPUS.map((c, i) => ({ ...c, embedding: vectors[i] }));

  function topKeys(query, lang) {
    const { vector } = composeQueryVector([], query);
    const scored = index
      .filter((c) => c.lang === lang && c.speaker === "bot")
      .map((c) => ({
        claim: c.claim,
        key: c.key,
        score:
          vector.reduce((s, v, i) => s + v * c.embedding[i], 0) /
          Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) /
          Math.sqrt(c.embedding.reduce((s, v) => s + v * v, 0)),
      }))
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 3);
  }

  for (const modelId of MODELS) {
    console.log(`\n=== ${modelId} ===`);
    const r = await load(modelId);
    for (const q of QUERIES) {
      const tops = topKeys(q.query, q.lang);
      const gate = await maxGateScore(
        r,
        q.query,
        tops.map((t) => t.key),
      );
      console.log(
        `${q.label}: gate=${gate.toFixed(4)} top=${tops.map((t) => `${t.claim}@${t.score.toFixed(3)}`).join(", ")}`,
      );
    }
  }
}

main().catch(console.error);
