/**
 * E2E grounded-generation negate-correct eval via chat API.
 * Requires dev server. Run: node scripts/eval-nli-engine.mjs
 */
const BASE = process.env.NOTALM_URL ?? "http://127.0.0.1:43123";

const NEGATE_CASES = [
  { lang: "ja", query: "あなたはRAGで生成しているの？", chunkPrefix: "mech-rag-a" },
  { lang: "en", query: "Do you generate with RAG?", chunkPrefix: "mech-rag-a" },
  { lang: "zh", query: "你是靠 RAG 生成的吗？", chunkPrefix: "mech-rag-a" },
  { lang: "ja", query: "コードを書いて", chunkPrefix: "code-1" },
  { lang: "en", query: "Write me some code", chunkPrefix: "code-1" },
  { lang: "zh", query: "帮我写点代码", chunkPrefix: "code-1" },
  { lang: "ja", query: "意識はある？", chunkPrefix: "phil-1" },
  { lang: "en", query: "Are you conscious?", chunkPrefix: "phil-1" },
  { lang: "zh", query: "有意识吗？", chunkPrefix: "phil-1" },
];

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${BASE}/api/status`);
    const s = await r.json();
    if (s.denseReady && s.nliReady) return s;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("not ready");
}

async function main() {
  const status = await waitReady();
  console.log(`nli: ${status.nliLabel} dtype=${status.nliDtype ?? "fp32"}`);

  let ok = 0;
  const fails = [];
  for (const tc of NEGATE_CASES) {
    const r = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userText: tc.query, generate: true, history: [] }),
    });
    const res = await r.json();
    const pass =
      res.trace?.operation === "negate-correct" &&
      res.message?.sourceChunkId?.startsWith(tc.chunkPrefix);
    if (pass) ok++;
    else
      fails.push({
        query: tc.query,
        op: res.trace?.operation,
        chunk: res.message?.sourceChunkId,
        nli: res.trace?.nliLabel,
        entail: res.trace?.nliScore,
      });
  }
  console.log(`negate-correct: ${ok}/${NEGATE_CASES.length}`);
  if (fails.length) console.log("fails:", fails);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
