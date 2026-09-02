/**
 * Fusion segment partition eval (Layer A/B/C).
 * Unit: offline partition candidates + preview.
 * API: trace.compoundSegments + operation (needs dev server).
 *
 * Run: node --experimental-strip-types scripts/eval-segment.mjs
 * API: NOTALM_URL=http://127.0.0.1:43123 node --experimental-strip-types scripts/eval-segment.mjs --api
 */
import {
  previewCompoundSegments,
  segmentCandidates,
} from "../src/lib/notalm/segment.ts";

function partitionKey(segs) {
  return segs.join("\x1f");
}

function hasPartition(candidates, expected) {
  const key = partitionKey(expected);
  return candidates.some((c) => partitionKey(c) === key);
}

function anyPartitionMatches(candidates, pred) {
  return candidates.some(pred);
}

const UNIT_CASES = [
  {
    name: "ja LLM diff stays single",
    lang: "ja",
    query: "LLM とはどう違う？",
    previewMax: 1,
    forbidBadSplit: true,
  },
  {
    name: "ja how-reply + mechanism sentence split",
    lang: "ja",
    query: "どうやって返答してる？仕組みは？",
    previewMin: 2,
    expectPartition: ["どうやって返答してる", "仕組み"],
    forbidBadSplit: true,
  },
  {
    name: "ja triple question no dangling って",
    lang: "ja",
    query: "言語モデルじゃないの？どうやって返答してる？仕組みは？",
    previewMin: 2,
    forbidBadSplit: true,
    forbidSegPrefix: "って",
  },
  {
    name: "ja mechanism + prior art conjunction",
    lang: "ja",
    query: "動作原理と既存の似た手法は？",
    expectPartition: ["動作原理", "既存の似た手法"],
  },
  {
    name: "en mechanism and prior art",
    lang: "en",
    query: "Explain the mechanism and the prior art",
    expectPartition: ["Explain the mechanism", "the prior art"],
  },
];

const API_POSITIVE = [
  {
    lang: "ja",
    query: "動作原理と既存の似た手法は？",
    expectSegmentCountMin: 2,
  },
];

const API_NEGATIVE = [
  { lang: "ja", query: "LLM とはどう違う？" },
];

const API_SEGMENT_QUALITY = [
  {
    lang: "ja",
    query: "どうやって返答してる？仕組みは？",
    expectSegments: ["どうやって返答してる", "仕組み"],
  },
  {
    lang: "ja",
    query: "言語モデルじゃないの？どうやって返答してる？仕組みは？",
    previewMin: 2,
    forbidBadSplit: true,
  },
];

function badJaSplit(segs) {
  if (segs.length < 2) return false;
  if (segs.some((s) => s.startsWith("って"))) return true;
  if (segs[0] === "どう" && segs.length >= 2) return true;
  if (segs.some((s) => s.startsWith("はどう"))) return true;
  return false;
}

function runUnit() {
  let ok = 0;
  for (const tc of UNIT_CASES) {
    const preview = previewCompoundSegments(tc.query, tc.lang);
    const candidates = segmentCandidates(tc.query, tc.lang);

    let pass = true;
    if (tc.previewMax != null && preview.length > tc.previewMax) pass = false;
    if (tc.previewMin != null && preview.length < tc.previewMin) pass = false;
    if (tc.expectPartition && !hasPartition(candidates, tc.expectPartition)) {
      pass = false;
    }
    if (tc.forbidBadSplit) {
      if (anyPartitionMatches(candidates, badJaSplit)) pass = false;
    }
    if (tc.forbidSegPrefix) {
      if (preview.some((s) => s.startsWith(tc.forbidSegPrefix))) pass = false;
    }

    console.log(`${pass ? "OK" : "FAIL"} unit ${tc.name}`);
    if (!pass) {
      console.log("  preview:", preview);
      console.log("  candidates:", candidates);
    }
    if (pass) ok++;
  }
  console.log(`unit: ${ok}/${UNIT_CASES.length}`);
  return ok === UNIT_CASES.length;
}

async function waitReady(base) {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${base}/api/status`);
    const s = await r.json();
    if (s.denseReady && s.rerankerReady) return;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("server not ready");
}

async function chat(base, query) {
  const r = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userText: query,
      generate: true,
      history: [],
      resetSession: true,
    }),
  });
  return r.json();
}

async function runApi(base) {
  await waitReady(base);
  let ok = 0;
  let total = 0;

  for (const tc of API_POSITIVE) {
    total++;
    const res = await chat(base, tc.query);
    const segs = res.trace?.debug?.compoundSegments ?? [];
    const pass =
      res.trace?.operation === "fuse" &&
      segs.length >= tc.expectSegmentCountMin;
    console.log(
      `${pass ? "OK" : "FAIL"} api+ ${tc.query.slice(0, 24)} op=${res.trace?.operation} segs=${JSON.stringify(segs)}`,
    );
    if (pass) ok++;
  }

  for (const tc of API_NEGATIVE) {
    total++;
    const res = await chat(base, tc.query);
    const segs = res.trace?.debug?.compoundSegments ?? [];
    const notFuse = res.trace?.operation !== "fuse";
    const segOk = segs.length < 2;
    const noBad = !badJaSplit(segs);
    const pass = notFuse && segOk && noBad;
    console.log(
      `${pass ? "OK" : "FAIL"} api- ${tc.query.slice(0, 24)} op=${res.trace?.operation} segs=${JSON.stringify(segs)}`,
    );
    if (pass) ok++;
  }

  for (const tc of API_SEGMENT_QUALITY) {
    total++;
    const res = await chat(base, tc.query);
    const segs = res.trace?.debug?.compoundSegments ?? [];
    const noBad = !badJaSplit(segs);
    const segMatch = tc.expectSegments
      ? JSON.stringify(segs) === JSON.stringify(tc.expectSegments)
      : true;
    const minOk = tc.previewMin ? segs.length >= tc.previewMin : true;
    const pass = noBad && segMatch && minOk;
    console.log(
      `${pass ? "OK" : "FAIL"} api~ ${tc.query.slice(0, 24)} segs=${JSON.stringify(segs)}`,
    );
    if (pass) ok++;
  }

  console.log(`api: ${ok}/${total}`);
  return ok === total;
}

async function main() {
  const unitOk = runUnit();
  if (process.argv.includes("--api")) {
    const base = process.env.NOTALM_URL ?? "http://127.0.0.1:43123";
    const apiOk = await runApi(base);
    process.exit(unitOk && apiOk ? 0 : 1);
  }
  process.exit(unitOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
