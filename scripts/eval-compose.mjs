/**
 * G4 span composition eval (unit + optional API).
 * Run: node --experimental-strip-types scripts/eval-compose.mjs
 */
import { pathToFileURL } from "node:url";
import {
  composeChangesReply,
  planComposeG4a,
  renderCompose,
} from "../src/lib/notalm/compose.ts";

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

const CASES = [
  {
    name: "negate-rag ja",
    query: "あなたはRAGで生成しているの？",
    claim: "mech-rag-a",
    lang: "ja",
    prefix: "negate-correct",
    expectSpanIds: ["no-gen"],
    expectIncludes: "生成段がなく",
    expectExcludes: "LLM に渡して",
  },
  {
    name: "negate-code en",
    query: "Write me some code",
    claim: "code-1",
    lang: "en",
    prefix: "negate-correct",
    expectSpanIds: ["deny-code"],
    expectIncludes: "don't write code",
    expectExcludes: "Instead I return",
  },
  {
    name: "focus-knn ja",
    query: "kNN-LMについて教えて",
    claim: "mech-existing",
    lang: "ja",
    expectSpanIds: ["item-knn", "closing"],
    expectIncludes: "kNN-LM",
    expectExcludes: "retrieval-only chatbot",
  },
  {
    name: "focus-embedding ja",
    query: "埋め込みはどう働く？",
    claim: "mech-1",
    lang: "ja",
    expectSpanIds: ["embed-match"],
    expectExcludes: "次のセリフ",
  },
];

async function main() {
  const base = new URL("..", import.meta.url);
  const { CHUNK_CORPUS } = await import(
    new URL("src/lib/notalm/corpus.ts", base).href
  );

  let pass = 0;
  for (const tc of CASES) {
    const chunk = CHUNK_CORPUS.find(
      (c) => c.claim === tc.claim && c.lang === tc.lang,
    );
    if (!chunk?.spans?.length) {
      console.log(`FAIL ${tc.name}: chunk missing spans`);
      continue;
    }
    const plan = planComposeG4a(tc.query, chunk, {
      prefix: tc.prefix,
    });
    if (!plan) {
      console.log(`FAIL ${tc.name}: no plan`);
      continue;
    }
    const text = renderCompose(plan, chunk, tc.lang, {
      negation: NEGATION_OPENER,
      affirm: AFFIRM_OPENER,
    });
    const keptIds = plan.kept.map((k) => k.spanId);
    const okIds = tc.expectSpanIds.every((id) => keptIds.includes(id));
    const okInc = !tc.expectIncludes || text.includes(tc.expectIncludes);
    const okExc = !tc.expectExcludes || !text.includes(tc.expectExcludes);
    const ok = okIds && okInc && okExc;
    if (ok) pass++;
    console.log(
      `${ok ? "OK" : "FAIL"} ${tc.name} kept=[${keptIds.join(",")}]`,
    );
    if (!ok) console.log("  text:", text.slice(0, 120));
  }
  console.log(`\nunit: ${pass}/${CASES.length}`);
}

main().catch(console.error);
