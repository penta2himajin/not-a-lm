/**
 * CE forward-count regression (fuse-first gate skip + per-turn cache).
 *
 * Unit: createCeScorer dedupe.
 * API: engine trace.ceForwards (needs dev server with this branch).
 *
 * Run: npm run eval:ce-reduction
 * API: NOTALM_URL=http://127.0.0.1:43123 npm run eval:ce-reduction
 */
import {
  createCeScorer,
  loadReranker,
  rerankScores,
} from "../src/lib/notalm/rerank.ts";
import { CHUNK_CORPUS } from "../src/lib/notalm/corpus.ts";

const BASE = process.env.NOTALM_URL ?? "http://127.0.0.1:43123";

// --- unit: cache dedupes repeated (query, key) ---
await loadReranker(() => {});
const keys = CHUNK_CORPUS.filter((c) => c.lang === "ja" && c.speaker === "bot")
  .slice(0, 3)
  .map((c) => c.key);
const q = "お前誰？";
const ce = createCeScorer();
await ce.score(q, keys);
await ce.score(q, keys);
const uncached = (await rerankScores(q, keys)).length;
if (ce.forwardCount !== uncached) {
  console.error(
    `FAIL cache unit: forwards=${ce.forwardCount} expected=${uncached}`,
  );
  process.exit(1);
}
console.log(`OK cache unit forwards=${ce.forwardCount}`);

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (!r.ok) throw new Error(String(r.status));
      const s = await r.json();
      if (s.denseReady && s.rerankerReady) return s;
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("API not ready — start dev server for API cases");
}

const API_CASES = [
  {
    name: "simple-in",
    query: "仕組みを教えて",
    generate: true,
    maxCe: 4,
  },
  {
    name: "compound-fuse",
    query: "動作原理と既存の似た手法は？",
    generate: true,
    maxCe: 24,
    expectOp: "fuse",
  },
  {
    name: "ooc-simple",
    query: "東京タワーの高さは？",
    generate: false,
    maxCe: 4,
  },
  {
    name: "ooc-compound",
    query: "東京タワーの高さとおすすめの映画は？",
    generate: true,
    maxCe: 4,
    expectFuse: false,
  },
];

let fail = 0;
try {
  await waitReady();
  for (const tc of API_CASES) {
    const r = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userText: tc.query,
        generate: tc.generate,
        history: [],
        resetSession: true,
      }),
    });
    const res = await r.json();
    const ceN = res.trace?.ceForwards;
    const okCe = ceN != null && ceN <= tc.maxCe;
    const okOp =
      (tc.expectOp === undefined || res.trace?.operation === tc.expectOp) &&
      (tc.expectFuse === undefined ||
        (res.trace?.operation === "fuse") === tc.expectFuse);
    const okLow =
      tc.expectLowConf === undefined ||
      res.trace?.lowConfidence === tc.expectLowConf;
    const ok = okCe && okOp && okLow;
    if (!ok) fail++;
    console.log(
      `${ok ? "OK" : "FAIL"} api ${tc.name} ce=${ceN ?? "n/a"} op=${res.trace?.operation} ` +
        `lowConf=${res.trace?.lowConfidence}`,
    );
  }
} catch (e) {
  console.log(`SKIP api cases: ${e instanceof Error ? e.message : e}`);
}

console.log(`\nce-reduction: unit OK, api fail=${fail}`);
process.exit(fail ? 1 : 0);
