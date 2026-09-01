/**
 * G6b anaphora unit eval (classify / inject / clarify plan+render).
 * Run: npm run eval:g6b
 */
import {
  classifyAnaphora,
  injectProximal,
  proximalFocusRef,
  planClarifyRecent,
  buildTurnGrounding,
} from "../src/lib/notalm/grounding.ts";
import {
  deriveOperationLabel,
  formatOperationPlan,
  renderOperationPlan,
  GROUNDED_OPENERS,
} from "../src/lib/notalm/plan.ts";
import { CHUNK_CORPUS } from "../src/lib/notalm/corpus.ts";

function chunk(claim, lang) {
  return CHUNK_CORPUS.find((c) => c.claim === claim && c.lang === lang);
}

let pass = 0;
let total = 0;

function check(name, ok, detail = "") {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? " " + detail : ""}`);
}

// classify
check("ja proximal それ", classifyAnaphora("それは生成してる？", "ja") === "proximal");
check("ja proximal その", classifyAnaphora("その仕組みは？", "ja") === "proximal");
check(
  "ja non-proximal さっきの",
  classifyAnaphora("さっきの話をもう一度", "ja") === "non-proximal",
);
check(
  "ja さっきの wins over それ",
  classifyAnaphora("さっきのそれは？", "ja") === "non-proximal",
);
check("ja none", classifyAnaphora("仕組みを教えて", "ja") === "none");
check("ja proximal 何が", classifyAnaphora("何が", "ja") === "proximal");
check(
  "ja proximal どういうこと",
  classifyAnaphora("どういうこと？", "ja") === "proximal",
);
check(
  "en proximal that one",
  classifyAnaphora("Tell me about that one", "en") === "proximal",
);
check(
  "en non-proximal earlier",
  classifyAnaphora("What about earlier?", "en") === "non-proximal",
);
check(
  "zh proximal 那个",
  classifyAnaphora("那个是生成的吗？", "zh") === "proximal",
);
check(
  "zh non-proximal 刚才",
  classifyAnaphora("刚才说的呢？", "zh") === "non-proximal",
);

// inject
{
  const c = chunk("mech-rag-a", "ja");
  const prior = buildTurnGrounding({
    chunk: c,
    operation: "compose",
    composePlan: {
      prefix: "negate-correct",
      kept: [{ chunkId: c.id, spanId: "no-gen" }],
    },
  });
  const inj = injectProximal("それは生成してるの？", prior);
  check(
    "inject contains excerpt",
    inj.effectiveQuery.includes(prior.excerptTexts[0]) &&
      inj.effectiveQuery.includes("それは生成してるの？"),
  );
  check("inject reasons", inj.reasons.some((r) => r.startsWith("g6b:proximal")));

  const focus = proximalFocusRef(prior);
  check(
    "focus-ref no query concat",
    focus != null &&
      focus.excerpt === prior.excerptTexts[0] &&
      focus.chunkId === c.id &&
      focus.reasons.some((r) => r === "g6b:proximal-focus"),
  );
}

// clarify plan + render
{
  const a = buildTurnGrounding({ chunk: chunk("mech-1", "ja") });
  const b = buildTurnGrounding({
    chunk: chunk("mech-rag-a", "ja"),
    composePlan: {
      kept: [{ chunkId: chunk("mech-rag-a", "ja").id, spanId: "no-gen" }],
    },
  });
  const plan = planClarifyRecent([a, b], "ja");
  check("clarify derive", deriveOperationLabel(plan) === "clarify");
  check(
    "clarify has closed+echo",
    plan.steps.some((s) => s.kind === "closed") &&
      plan.steps.filter((s) => s.kind === "echo").length === 2,
  );
  const text = renderOperationPlan(
    plan,
    () => undefined,
    "ja",
    GROUNDED_OPENERS,
  );
  check(
    "clarify render ja",
    text.startsWith("どれのことですか。") &&
      text.includes("それ以外なら、どんなものだったか思い出せる範囲で教えて。") &&
      text.includes(a.excerptTexts[0]) &&
      text.includes(b.excerptTexts[0]),
    text.slice(0, 80),
  );
  check(
    "clarify format",
    formatOperationPlan(plan).includes("clarify?"),
  );
}

console.log(`\ng6b: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
