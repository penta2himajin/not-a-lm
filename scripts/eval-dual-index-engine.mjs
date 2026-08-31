/**
 * API E2E dual-index eval. Requires dev server.
 * Run: node scripts/eval-dual-index-engine.mjs
 */
import {
  BASELINE_CASES,
  FOCUS_CASES,
  GATE_SAFETY_CASES,
  MECH2_CASES,
} from "./eval-retrieval-cases.mjs";

const BASE = process.env.NOTALM_URL ?? "http://127.0.0.1:43123";

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${BASE}/api/status`);
    const s = await r.json();
    if (s.denseReady) return s;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("not ready");
}

function claimFromId(id) {
  return id?.replace(/-(ja|en|zh)$/, "") ?? "";
}

async function evalCases(label, cases, opts = {}) {
  let ok = 0;
  const rows = [];
  for (const tc of cases) {
    const r = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userText: tc.query,
        generate: true,
        history: [],
        resetSession: true,
      }),
    });
    const res = await r.json();
    const got = claimFromId(res.message?.sourceChunkId);
    let pass;
    if (opts.rejectClaim) {
      pass = got !== tc.rejectClaim;
    } else {
      pass = got === tc.claim;
    }
    if (pass) ok++;
    rows.push({
      lang: tc.lang,
      query: tc.query,
      want: tc.claim ?? `!${tc.rejectClaim}`,
      got,
      pass,
      retrievalSource: res.trace?.retrievalSource,
      matchedSpanId: res.trace?.matchedSpanId,
      op: res.trace?.operation,
      lowConfidence: res.trace?.lowConfidence,
    });
  }
  console.log(`\n=== ${label} ===`);
  console.log(`${ok}/${cases.length}`);
  for (const row of rows) {
    console.log(
      `${row.pass ? "OK" : "FAIL"} ${row.lang} ${row.want} → ${row.got} [${row.retrievalSource}${row.matchedSpanId ? `:${row.matchedSpanId}` : ""}] op=${row.op}${row.lowConfidence ? " LOW" : ""}`,
    );
  }
  return { ok, total: cases.length };
}

async function main() {
  await waitReady();
  const focus = await evalCases("focus", FOCUS_CASES);
  const mech2 = await evalCases("mech2", MECH2_CASES);
  const gate = await evalCases("gate-safety", GATE_SAFETY_CASES, {
    rejectClaim: true,
  });
  const baseline = await evalCases("baseline", BASELINE_CASES);
  console.log(
    `\nTOTAL: focus ${focus.ok}/${focus.total}, mech2 ${mech2.ok}/${mech2.total}, gate ${gate.ok}/${gate.total}, baseline ${baseline.ok}/${baseline.total}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
