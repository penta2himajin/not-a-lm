/**
 * G6d chain plan unit eval.
 * Run: npm run eval:g6d
 */
import {
  buildChainDemoPlan,
  findChunkByClaim,
  formatChainPlan,
  validateChainPlan,
  CHAIN_SEED_CLAIM,
  CHAIN_DEMO_USER_CLAIMS,
} from "../src/lib/notalm/chain-plan.ts";

let pass = 0;
let total = 0;

function check(name, ok, detail = "") {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? " " + detail : ""}`);
}

{
  const plan = buildChainDemoPlan({ lang: "ja", pairCount: 3 });
  check("seed claim", plan.seedClaim === CHAIN_SEED_CLAIM);
  check("pairCount", plan.pairCount === 3);
  check("steps = 6", plan.steps.length === 6);
  check(
    "alt roles",
    plan.steps.every((s, i) =>
      i % 2 === 0 ? s.role === "user" : s.role === "bot",
    ),
  );
  check(
    "user corpus / bot generate",
    plan.steps.filter((s) => s.role === "user").every((s) => s.resolve === "corpus") &&
      plan.steps.filter((s) => s.role === "bot").every((s) => s.resolve === "generate"),
  );
  const errs = validateChainPlan(plan);
  check("validate empty", errs.length === 0, errs.join(","));
  check(
    "format",
    formatChainPlan(plan).includes("U:chain-user-predict") &&
      formatChainPlan(plan).includes("B:gen"),
    formatChainPlan(plan),
  );
  check("reasons", plan.reasons.some((r) => r.startsWith("g6d:demo")));
}

{
  for (const lang of ["ja", "en", "zh"]) {
    for (const claim of CHAIN_DEMO_USER_CLAIMS[lang]) {
      const c = findChunkByClaim(claim, lang, "user");
      check(`${lang}/${claim}`, !!c && c.speaker === "user" && !!c.value);
    }
  }
}

{
  const p = buildChainDemoPlan({ lang: "ja", pairCount: 2, userClaimOffset: 1 });
  check(
    "offset skips first",
    p.steps[0].claim === CHAIN_DEMO_USER_CLAIMS.ja[1],
  );
}

{
  const bad = buildChainDemoPlan({ lang: "ja", pairCount: 1 });
  bad.steps[0].claim = "no-such-claim";
  const errs = validateChainPlan(bad);
  check("validate catches missing", errs.some((e) => e.includes("missing")));
}

console.log(`\ng6d: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
