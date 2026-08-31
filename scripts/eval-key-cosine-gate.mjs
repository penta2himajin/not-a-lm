/** Test bi-encoder cosine on keyword keys as reranker-free gate signal. */
import { pathToFileURL } from "node:url";

const base = new URL("..", import.meta.url);
const importTs = (rel) => import(pathToFileURL(new URL(rel, base).pathname).href);

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

const IN = [
  { lang: "ja", query: "仕組みを教えて", claim: "mech-1" },
  { lang: "ja", query: "あなたは誰？", claim: "who-1" },
  { lang: "en", query: "How does this work?", claim: "mech-1" },
  { lang: "en", query: "Can you write code?", claim: "code-1" },
  { lang: "en", query: "What do you mean by KV?", claim: "var-attention" },
  { lang: "zh", query: "工作原理是什么？", claim: "mech-1" },
];
const OOC = [
  { lang: "ja", query: "今日の天気は？" },
  { lang: "en", query: "What's the weather today?" },
  { lang: "zh", query: "今天天气怎么样？" },
  { lang: "en", query: "Explain Python list comprehensions" },
];

async function main() {
  const { CHUNK_CORPUS } = await importTs("src/lib/notalm/corpus.ts");
  const { embedMany, loadDense } = await importTs("src/lib/notalm/embed.ts");
  await loadDense();

  const keyVecs = await embedMany(CHUNK_CORPUS.map((c) => c.key), "dense");
  const index = CHUNK_CORPUS.map((c, i) => ({ ...c, keyEmb: keyVecs[i] }));

  async function maxKeyCos(query, lang) {
    const [qVec] = await embedMany([query], "dense");
    const tops = index
      .filter((c) => c.lang === lang && c.speaker === "bot")
      .map((c) => ({ claim: c.claim, cos: cosine(qVec, c.keyEmb) }))
      .sort((a, b) => b.cos - a.cos)
      .slice(0, 3);
    return { max: tops[0]?.cos ?? 0, tops };
  }

  const inScores = [];
  for (const tc of IN) {
    const { max, tops } = await maxKeyCos(tc.query, tc.lang);
    inScores.push(max);
    console.log(`IN ${tc.lang} "${tc.query}" max=${max.toFixed(3)} top=${tops.map((t) => t.claim).join(",")}`);
  }
  const oocScores = [];
  for (const tc of OOC) {
    const { max, tops } = await maxKeyCos(tc.query, tc.lang);
    oocScores.push(max);
    console.log(`OOC ${tc.lang} "${tc.query}" max=${max.toFixed(3)} top=${tops.map((t) => t.claim).join(",")}`);
  }
  console.log(
    `\nin [${Math.min(...inScores).toFixed(3)}, ${Math.max(...inScores).toFixed(3)}] ooc [${Math.min(...oocScores).toFixed(3)}, ${Math.max(...oocScores).toFixed(3)}]`,
  );
}

main().catch(console.error);
