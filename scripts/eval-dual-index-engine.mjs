/**
 * API E2E dual-index focus eval. Requires dev server.
 * Run: node scripts/eval-dual-index-engine.mjs
 */
const BASE = process.env.NOTALM_URL ?? "http://127.0.0.1:43123";

const FOCUS_CASES = [
  { lang: "ja", query: "kNN-LMについて教えて", claim: "mech-existing" },
  { lang: "en", query: "Tell me about kNN-LM", claim: "mech-existing" },
  { lang: "zh", query: "讲讲 kNN-LM", claim: "mech-existing" },
  { lang: "ja", query: "埋め込みはどう働く？", claim: "mech-1" },
  { lang: "en", query: "How does embedding work?", claim: "mech-1" },
  { lang: "zh", query: "嵌入是怎么工作的？", claim: "mech-1" },
];

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${BASE}/api/status`);
    const s = await r.json();
    if (s.denseReady) return s;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("not ready");
}

async function main() {
  await waitReady();
  let ok = 0;
  const rows = [];
  for (const tc of FOCUS_CASES) {
    const r = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userText: tc.query, generate: true, history: [] }),
    });
    const res = await r.json();
    const pass = res.message?.sourceChunkId?.startsWith(tc.claim);
    if (pass) ok++;
    rows.push({
      lang: tc.lang,
      query: tc.query,
      want: tc.claim,
      got: res.message?.sourceChunkId?.replace(/-(ja|en|zh)$/, ""),
      pass,
      retrievalSource: res.trace?.retrievalSource,
      matchedSpanId: res.trace?.matchedSpanId,
      op: res.trace?.operation,
    });
  }
  console.log(`focus dual-index API: ${ok}/${FOCUS_CASES.length}`);
  for (const row of rows) {
    console.log(
      `${row.pass ? "OK" : "FAIL"} ${row.lang} ${row.want} → ${row.got} [${row.retrievalSource}${row.matchedSpanId ? `:${row.matchedSpanId}` : ""}] op=${row.op}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
