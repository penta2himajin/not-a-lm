/**
 * End-to-end reranker eval via the chat API (dense embed + gate + fusion).
 * Requires dev server: npm run dev -- --port 43123
 * Run: node --experimental-strip-types scripts/eval-reranker-engine.mjs
 */
const BASE = process.env.NOTALM_URL ?? "http://127.0.0.1:43123";

const IN_CORPUS = [
  { lang: "ja", query: "あなたは誰？", expectClaim: "who-1" },
  { lang: "ja", query: "仕組みを教えて", expectClaim: "mech-1" },
  { lang: "ja", query: "KVキャッシュって何？", expectClaim: "var-attention" },
  { lang: "ja", query: "コード書ける？", expectClaim: "code-1" },
  { lang: "ja", query: "こんにちは", expectClaim: "greet-intro" },
  { lang: "en", query: "Who are you?", expectClaim: "who-1" },
  { lang: "en", query: "How does this work?", expectClaim: "mech-1" },
  { lang: "en", query: "What do you mean by KV?", expectClaim: "var-attention" },
  { lang: "en", query: "Can you write code?", expectClaim: "code-1" },
  { lang: "en", query: "Hello there", expectClaim: "greet-intro" },
  { lang: "zh", query: "你是谁？", expectClaim: "who-1" },
  { lang: "zh", query: "工作原理是什么？", expectClaim: "mech-1" },
  { lang: "zh", query: "KV缓存是什么？", expectClaim: "var-attention" },
  { lang: "zh", query: "你会写代码吗？", expectClaim: "code-1" },
  { lang: "zh", query: "你好", expectClaim: "greet-intro" },
];

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

const FUSION = [
  {
    lang: "ja",
    query: "動作原理と既存の似た手法は？",
    expectClaims: ["mech-1", "mech-existing"],
  },
  {
    lang: "en",
    query: "Explain the mechanism and the prior art",
    expectClaims: ["mech-1", "mech-existing"],
  },
  {
    lang: "zh",
    query: "讲讲原理和已有的类似方法",
    expectClaims: ["mech-1", "mech-existing"],
  },
];

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${BASE}/api/status`);
    const s = await r.json();
    if (s.denseReady && s.rerankerReady) return s;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("models not ready");
}

async function chat(userText, generate = false) {
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userText, generate, history: [] }),
  });
  return r.json();
}

async function main() {
  const status = await waitReady();
  console.log(`reranker: ${status.rerankerLabel} (${status.rerankerReady})`);

  let inOk = 0;
  const inFails = [];
  for (const tc of IN_CORPUS) {
    const res = await chat(tc.query);
    const id = res.message?.sourceChunkId ?? "";
    const expectId = `${tc.expectClaim}-${tc.lang}`;
    const ok = !res.trace?.lowConfidence && id === expectId;
    if (ok) inOk++;
    else
      inFails.push({
        query: tc.query,
        got: id,
        lowConf: res.trace?.lowConfidence,
        conf: res.trace?.topRerankScore,
      });
  }

  let oocOk = 0;
  const oocFails = [];
  for (const tc of OOC) {
    const res = await chat(tc.query);
    const ok = res.trace?.lowConfidence === true;
    if (ok) oocOk++;
    else
      oocFails.push({
        query: tc.query,
        got: res.message?.sourceChunkId,
        conf: res.trace?.topRerankScore,
      });
  }

  let fuseOk = 0;
  const fuseFails = [];
  for (const tc of FUSION) {
    const res = await chat(tc.query, true);
    const ok = res.trace?.operation === "fuse";
    if (ok) fuseOk++;
    else
      fuseFails.push({
        query: tc.query,
        op: res.trace?.operation,
        got: res.message?.sourceChunkId,
      });
  }

  console.log(`in-corpus: ${inOk}/${IN_CORPUS.length}`);
  if (inFails.length) console.log("  fails:", inFails);
  console.log(`ooc refuse: ${oocOk}/${OOC.length}`);
  if (oocFails.length) console.log("  fails:", oocFails);
  console.log(`fusion: ${fuseOk}/${FUSION.length}`);
  if (fuseFails.length) console.log("  fails:", fuseFails);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
