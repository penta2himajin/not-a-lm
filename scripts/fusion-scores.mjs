/** Fusion segment×candidate scores for reranker comparison. */
const MODELS = process.argv.slice(2);
if (!MODELS.length) {
  MODELS.push(
    "Xenova/bge-reranker-base",
    "SugoLabs/mmarco-mMiniLMv2-L12-H384-v1",
  );
}

const CASES = [
  {
    lang: "ja",
    query: "動作原理と既存の似た手法は？",
    segments: ["動作原理", "既存の似た手法"],
    expect: ["mech-1", "mech-existing"],
  },
  {
    lang: "en",
    query: "Explain the mechanism and the prior art",
    segments: ["the mechanism", "the prior art"],
    expect: ["mech-1", "mech-existing"],
  },
];

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

async function load(modelId) {
  const { AutoTokenizer, AutoModelForSequenceClassification, env } =
    await import("@huggingface/transformers");
  env.cacheDir = "/tmp/notalm-embed-cache";
  return {
    tokenizer: await AutoTokenizer.from_pretrained(modelId),
    model: await AutoModelForSequenceClassification.from_pretrained(modelId, {
      dtype: "fp32",
      device: "cpu",
    }),
  };
}

async function score(r, query, key) {
  const inputs = await r.tokenizer([query], {
    text_pair: [key],
    padding: true,
    truncation: true,
  });
  const { logits } = await r.model(inputs);
  const rows = logits.tolist();
  const val = Array.isArray(rows[0]) ? rows[0][0] : rows[0];
  return sigmoid(val);
}

async function main() {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const require = createRequire(import.meta.url);
  const baseUrl = new URL("..", import.meta.url);
  const { CHUNK_CORPUS } = await import(
    pathToFileURL(new URL("src/lib/notalm/corpus.ts", baseUrl).pathname).href
  );

  for (const modelId of MODELS) {
    console.log(`\n=== ${modelId} ===`);
    const r = await load(modelId);
    for (const tc of CASES) {
      const chunks = CHUNK_CORPUS.filter(
        (c) => c.lang === tc.lang && c.speaker === "bot",
      );
      const targets = tc.expect.map((claim) => chunks.find((c) => c.claim === claim));
      console.log(`\n${tc.lang}: ${tc.query}`);
      for (const seg of tc.segments) {
        const row = await Promise.all(
          targets.map(async (t) => `${t.claim}=${(await score(r, seg, t.key)).toFixed(3)}`),
        );
        console.log(`  seg "${seg}": ${row.join("  ")}`);
      }
      const full = await Promise.all(
        targets.map(async (t) => `${t.claim}=${(await score(r, tc.query, t.key)).toFixed(3)}`),
      );
      console.log(`  full query: ${full.join("  ")}`);
    }
  }
}

main().catch(console.error);
