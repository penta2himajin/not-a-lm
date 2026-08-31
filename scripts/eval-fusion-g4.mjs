/**
 * G3×G4 eval: fusion applies per-segment G4 compose.
 * Unit: planCompose on fusion segments (offline).
 * API: compound queries (needs dev server).
 *
 * Run: node --experimental-strip-types scripts/eval-fusion-g4.mjs
 * API: NOTALM_URL=http://127.0.0.1:43123 node scripts/eval-fusion-g4.mjs --api
 */
import { CHUNK_CORPUS } from "../src/lib/notalm/corpus.ts";
import { composePartBody } from "../src/lib/notalm/compose.ts";
import { loadDense } from "../src/lib/notalm/embed.ts";

const NEGATION_OPENER = {
  ja: "いいえ、そうではありません。",
  en: "No, that's not the case. ",
  zh: "不，并不是这样。",
};
const AFFIRM_OPENER = {
  ja: "はい、その通りです。",
  en: "Yes, exactly. ",
  zh: "对，正是如此。",
};

const UNIT_CASES = [
  {
    name: "ja prior-art segment narrows mech-existing",
    lang: "ja",
    segment: "既存の似た手法",
    claim: "mech-existing",
    expectPlan: true,
    expectExcludes: "あるよ。",
    expectIncludes: "retrieval-only chatbot",
  },
  {
    name: "en prior art segment narrows mech-existing",
    lang: "en",
    segment: "the prior art",
    claim: "mech-existing",
    expectPlan: true,
    expectExcludes: "Sure.",
    expectIncludes: "retrieval-only chatbots",
  },
  {
    name: "zh prior art segment narrows mech-existing",
    lang: "zh",
    segment: "已有的类似方法",
    claim: "mech-existing",
    expectPlan: true,
    expectExcludes: "有的。",
    expectIncludes: "retrieval-only chatbot",
  },
];

const API_CASES = [
  {
    lang: "ja",
    query: "動作原理と既存の似た手法は？",
    rejectPatterns: ["については、あるよ。"],
    requireFusedCompose: true,
  },
  {
    lang: "en",
    query: "Explain the mechanism and the prior art",
    rejectPatterns: ["As for the prior art, Sure."],
    requireFusedCompose: true,
  },
  {
    lang: "zh",
    query: "讲讲原理和已有的类似方法",
    rejectPatterns: ["至于已有的类似方法，有的。"],
    requireFusedCompose: true,
  },
];

function chunkByClaim(claim, lang) {
  return CHUNK_CORPUS.find((c) => c.claim === claim && c.lang === lang);
}

async function runUnit() {
  await loadDense(() => {});
  let ok = 0;
  for (const tc of UNIT_CASES) {
    const chunk = chunkByClaim(tc.claim, tc.lang);
    const openers = { negation: NEGATION_OPENER, affirm: AFFIRM_OPENER };
    const { text, plan } = await composePartBody(
      tc.segment,
      chunk,
      tc.lang,
      openers,
    );
    const pass =
      Boolean(plan) === tc.expectPlan &&
      !text.includes(tc.expectExcludes) &&
      text.includes(tc.expectIncludes);
    console.log(`${pass ? "OK" : "FAIL"} unit ${tc.name}`);
    if (!pass) console.log("  text:", text.slice(0, 120));
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

async function runApi(base) {
  await waitReady(base);
  let ok = 0;
  for (const tc of API_CASES) {
    const r = await fetch(`${base}/api/chat`, {
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
    const text = res.message?.text ?? "";
    const pass =
      res.trace?.operation === "fuse" &&
      (!tc.requireFusedCompose || res.trace?.fusedCompose === true) &&
      tc.rejectPatterns.every((p) => !text.includes(p));
    console.log(
      `${pass ? "OK" : "FAIL"} api ${tc.lang} op=${res.trace?.operation} fusedCompose=${res.trace?.fusedCompose}`,
    );
    if (!pass) console.log("  text:", text.slice(0, 160));
    if (pass) ok++;
  }
  console.log(`api: ${ok}/${API_CASES.length}`);
  return ok === API_CASES.length;
}

async function main() {
  const apiMode = process.argv.includes("--api");
  const unitOk = await runUnit();
  if (apiMode) {
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
