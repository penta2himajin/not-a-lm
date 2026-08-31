/**
 * G6c continuity scoring unit eval.
 * Run: npm run eval:g6c
 */
import {
  REUSE_PENALTY,
  CONTINUITY_CLAIM_BOOST,
  adjustScoreForContinuity,
  continuityFromPrior,
} from "../src/lib/notalm/grounding.ts";

let pass = 0;
let total = 0;

function check(name, ok, detail = "") {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? " " + detail : ""}`);
}

const used = new Set(["chunk-a"]);
const continuity = {
  chunkId: "chunk-a",
  claim: "mech-rag-a",
};

{
  const raw = 0.8;
  const plain = adjustScoreForContinuity(raw, { id: "chunk-a" }, used);
  check(
    "reuse penalty without continuity",
    Math.abs(plain.score - (raw - REUSE_PENALTY)) < 1e-9,
    String(plain.score),
  );
}

{
  const raw = 0.8;
  const cont = adjustScoreForContinuity(
    raw,
    { id: "chunk-a", claim: "mech-rag-a" },
    used,
    continuity,
  );
  check(
    "same chunk waives reuse",
    cont.score > raw - REUSE_PENALTY && cont.notes.includes("g6c:reuse-waive"),
    String(cont.score),
  );
  check(
    "same chunk continue note",
    cont.notes.includes("g6c:chunk-continue"),
  );
}

{
  const raw = 0.75;
  const other = adjustScoreForContinuity(
    raw,
    { id: "chunk-b", claim: "mech-rag-a" },
    used,
    continuity,
  );
  // chunk-b not in used → no penalty, claim boost
  check(
    "same claim boost",
    Math.abs(other.score - (raw + CONTINUITY_CLAIM_BOOST)) < 1e-9 &&
      other.notes.includes("g6c:claim-boost"),
    String(other.score),
  );
}

{
  const raw = 0.75;
  const usedOther = adjustScoreForContinuity(
    raw,
    { id: "chunk-b", claim: "other" },
    used,
    continuity,
  );
  // chunk-b not in used
  check("unrelated no change", Math.abs(usedOther.score - raw) < 1e-9);
}

{
  const usedB = new Set(["chunk-b"]);
  const raw = 0.75;
  const penalized = adjustScoreForContinuity(
    raw,
    { id: "chunk-b", claim: "other" },
    usedB,
    continuity,
  );
  check(
    "unrelated used still penalized",
    Math.abs(penalized.score - (raw - REUSE_PENALTY)) < 1e-9,
  );
}

{
  const hint = continuityFromPrior({
    chunkId: "x",
    claim: "c",
    excerptTexts: ["hi"],
    kept: [{ chunkId: "x", spanId: "s1" }],
  });
  check("fromPrior", hint?.chunkId === "x" && hint.keptSpanIds?.[0] === "s1");
  check("fromPrior empty", continuityFromPrior(undefined) == null);
}

console.log(`\ng6c: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
