/**
 * S3 — static claim-edge unit eval (no network).
 * Run: npm run eval:topic-edges
 */
import {
  buildClaimEdgeIndex,
  cleanAuthorEdges,
  elaboratesSatellite,
  fusePairBonus,
  orderPartsByNuclearity,
  relationBetween,
  retrievalEdgeBonus,
} from "../src/lib/notalm/topic-edges.ts";
import { CORPUS_CLAIMS } from "../src/lib/notalm/corpus.ts";

let pass = 0;
let total = 0;

function check(name, ok, detail = "") {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const index = buildClaimEdgeIndex(CORPUS_CLAIMS);

check(
  "pilot elaborates mech-1 → mech-1-detail",
  relationBetween(index, "mech-1", "mech-1-detail") === "elaborates",
  String(relationBetween(index, "mech-1", "mech-1-detail")),
);

check(
  "pilot parallel mech-1 ↔ mech-existing",
  relationBetween(index, "mech-1", "mech-existing") === "parallel",
);

check(
  "pilot parallel help-1 ↔ help-2",
  relationBetween(index, "help-1", "help-2") === "parallel",
);

check(
  "pilot contrasts help-2 ↔ limit-1",
  relationBetween(index, "help-2", "limit-1") === "contrasts",
);

check(
  "fuse pair bonus > 0 for parallel",
  fusePairBonus(index, "help-1", "help-2") > 0,
);

check(
  "retrieval bonus > 0 for edge neighbor",
  retrievalEdgeBonus(index, "mech-1", "mech-2") > 0,
);

check(
  "retrieval bonus 0 for unrelated",
  retrievalEdgeBonus(index, "mech-1", "bye-1") === 0,
);

check(
  "elaboratesSatellite(mech-1) → mech-1-detail",
  elaboratesSatellite(index, "mech-1") === "mech-1-detail",
);

{
  const parts = [
    { chunk: { claim: "mech-1-detail" }, seg: "詳しく" },
    { chunk: { claim: "mech-1" }, seg: "仕組み" },
  ];
  const ordered = orderPartsByNuclearity(parts, index);
  check(
    "nuclearity reorder nucleus first",
    ordered.parts[0].chunk.claim === "mech-1" &&
      ordered.parts[1].chunk.claim === "mech-1-detail",
    ordered.parts.map((p) => p.chunk.claim).join(","),
  );
  check(
    "nuclearity note emitted",
    ordered.notes.some((n) => n.includes("nuclearity") || n.includes("s3:")),
    ordered.notes.join("|"),
  );
}

{
  const cleaned = cleanAuthorEdges(
    [
      { rel: "parallel", to: "help-2" },
      { rel: "parallel", to: "help-2" },
      { rel: "nope", to: "x" },
      { rel: "elaborates", to: "help-1" },
    ],
    "help-1",
  );
  check(
    "cleanAuthorEdges drops self/invalid/dup",
    cleaned?.length === 1 && cleaned[0].to === "help-2",
    JSON.stringify(cleaned),
  );
}

{
  const withEdges = CORPUS_CLAIMS.filter((c) => c.edges?.length);
  check(
    "pilot corpus has ≥4 edged claims",
    withEdges.length >= 4,
    String(withEdges.length),
  );
}

console.log(`\ntopic-edges: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
