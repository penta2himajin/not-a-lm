/**
 * G4c per-span NLI compose eval (unit + NLI integration).
 * Run: node --experimental-strip-types scripts/eval-g4c-compose.mjs
 */
import {
  G4C_ENTAIL_MIN,
  planComposeG4a,
  rankSpansByNli,
  renderCompose,
} from "../src/lib/notalm/compose.ts";
import { loadDense } from "../src/lib/notalm/embed.ts";
import { loadNli } from "../src/lib/notalm/nli.ts";

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

/** Rule 2c / rankSpansByNli with manual rankings (no model). */
const UNIT_CASES = [
  {
    name: "g4c-help-chain ja",
    query: "連鎖ボタンって何？",
    claim: "help-1",
    lang: "ja",
    spanNliRankings: [
      { spanId: "chain-btn", entail: 0.82, label: "entailment" },
      { spanId: "ui-hits", entail: 0.21, label: "neutral" },
      { spanId: "talk", entail: 0.15, label: "neutral" },
    ],
    expectSpanIds: ["chain-btn"],
    expectIncludes: "連鎖ボタン",
    expectExcludes: "右側",
  },
  {
    name: "g4c-help-ui en",
    query: "What does the right panel show about keys?",
    claim: "help-1",
    lang: "en",
    spanNliRankings: [
      { spanId: "ui-hits", entail: 0.79, label: "entailment" },
      { spanId: "chain-btn", entail: 0.18, label: "neutral" },
    ],
    expectSpanIds: ["ui-hits"],
    expectIncludes: "which key won",
    expectExcludes: "chain button",
  },
  {
    name: "g4c-help-chain zh",
    query: "连锁按钮是干什么的？",
    claim: "help-1",
    lang: "zh",
    spanNliRankings: [
      { spanId: "chain-btn", entail: 0.85, label: "entailment" },
      { spanId: "ui-hits", entail: 0.12, label: "neutral" },
    ],
    expectSpanIds: ["chain-btn"],
    expectIncludes: "连锁按钮",
    expectExcludes: "哪个键",
  },
];

/** Live NLI: rankSpansByNli + planComposeG4a (tags/G4b suppressed). */
const NLI_CASES = [
  {
    name: "nli-help-chain ja",
    query: "連鎖ボタンで自動予測できる？",
    claim: "help-1",
    lang: "ja",
    expectSpanIds: ["chain-btn"],
    expectIncludes: "連鎖ボタン",
    minTopEntail: G4C_ENTAIL_MIN,
  },
  {
    name: "nli-help-ui en",
    query: "Can I see which key won on the right?",
    claim: "help-1",
    lang: "en",
    expectSpanIds: ["ui-hits"],
    expectIncludes: "which key won",
    minTopEntail: G4C_ENTAIL_MIN,
  },
  {
    name: "nli-mech-pick ja",
    query: "次のセリフはどう決まる？",
    claim: "mech-1",
    lang: "ja",
    expectSpanIds: ["pick-value"],
    expectIncludes: "次のセリフ",
    minTopEntail: G4C_ENTAIL_MIN,
  },
];

function runCase(tc, chunk, spanNliRankings) {
  const plan = planComposeG4a(tc.query, chunk, {
    spanNliRankings,
    spanRankings: [],
  });
  if (!plan) return { ok: false, reason: "no plan", keptIds: [] };
  const text = renderCompose(plan, chunk, tc.lang, {
    negation: NEGATION_OPENER,
    affirm: AFFIRM_OPENER,
  });
  const keptIds = plan.kept.map((k) => k.spanId);
  const okIds = tc.expectSpanIds.every((id) => keptIds.includes(id));
  const okInc = !tc.expectIncludes || text.includes(tc.expectIncludes);
  const okExc = !tc.expectExcludes || !text.includes(tc.expectExcludes);
  return { ok: okIds && okInc && okExc, keptIds, text };
}

async function main() {
  await loadDense(() => {});
  const base = new URL("..", import.meta.url);
  const { CHUNK_CORPUS } = await import(
    new URL("src/lib/notalm/corpus.ts", base).href
  );

  let pass = 0;
  let total = 0;

  for (const tc of UNIT_CASES) {
    total++;
    const chunk = CHUNK_CORPUS.find(
      (c) => c.claim === tc.claim && c.lang === tc.lang,
    );
    if (!chunk?.spans?.length) {
      console.log(`FAIL ${tc.name}: chunk missing spans`);
      continue;
    }
    const { ok, keptIds, text } = runCase(tc, chunk, tc.spanNliRankings);
    if (ok) pass++;
    console.log(
      `${ok ? "OK" : "FAIL"} ${tc.name} kept=[${keptIds.join(",")}]`,
    );
    if (!ok) console.log("  text:", text?.slice(0, 120));
  }

  console.log("\nLoading NLI for integration cases…");
  await loadNli(() => {});

  for (const tc of NLI_CASES) {
    total++;
    const chunk = CHUNK_CORPUS.find(
      (c) => c.claim === tc.claim && c.lang === tc.lang,
    );
    if (!chunk?.spans?.length) {
      console.log(`FAIL ${tc.name}: chunk missing spans`);
      continue;
    }
    const spanNliRankings = await rankSpansByNli(tc.query, chunk.spans);
    const top = spanNliRankings[0];
    const { ok, keptIds, text } = runCase(tc, chunk, spanNliRankings);
    const okEntail = (top?.entail ?? 0) >= (tc.minTopEntail ?? G4C_ENTAIL_MIN);
    const allOk = ok && okEntail;
    if (allOk) pass++;
    console.log(
      `${allOk ? "OK" : "FAIL"} ${tc.name} top=${top?.spanId}@${top?.entail?.toFixed(2)} kept=[${keptIds.join(",")}]`,
    );
    if (!allOk) console.log("  text:", text?.slice(0, 120));
  }

  console.log(`\ng4c: ${pass}/${total}`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
