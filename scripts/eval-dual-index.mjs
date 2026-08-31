/**
 * Dual-index retrieval eval: natKey-only vs dual merge top-1 claim accuracy.
 * Run: node --experimental-strip-types scripts/eval-dual-index.mjs
 */
import { CHUNK_CORPUS } from "../src/lib/notalm/corpus.ts";
import { cosine, embedMany, loadDense } from "../src/lib/notalm/embed.ts";
import {
  buildSpanIndexManifest,
  KEY_POOL,
  mergeDualRetrieval,
  searchSpanIndex,
} from "../src/lib/notalm/span-index.ts";
import {
  BASELINE_CASES,
  FOCUS_CASES,
  MECH2_CASES,
} from "./eval-retrieval-cases.mjs";

function keySearch(queryVec, index, lang, limit) {
  const scored = [];
  for (const chunk of index) {
    if (chunk.speaker !== "bot") continue;
    if (chunk.lang !== lang) continue;
    scored.push({
      chunk,
      score: cosine(queryVec, chunk.embedding),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => ({
    chunk: s.chunk,
    score: s.score,
  }));
}

async function evalMode(name, cases, index, spanIndex, chunkById) {
  let ok = 0;
  const fails = [];
  for (const tc of cases) {
    const qv = (await embedMany([tc.query], "dense"))[0];
    const keyHits = keySearch(qv, index, tc.lang, KEY_POOL);
    let chosen = keyHits[0];
    let source = "natKey";

    if (name === "dual" && spanIndex.length) {
      const spanHits = searchSpanIndex(qv, spanIndex, chunkById, tc.lang);
      const dual = mergeDualRetrieval(
        qv,
        keyHits,
        spanHits,
        chunkById,
        new Set(),
        tc.query,
      );
      chosen = dual.chosen;
      source = dual.retrievalSource;
    }

    const pass = chosen?.chunk.claim === tc.claim;
    if (pass) ok++;
    else
      fails.push({
        query: tc.query,
        want: tc.claim,
        got: chosen?.chunk.claim,
        source,
      });
  }
  return { ok, total: cases.length, fails };
}

async function main() {
  await loadDense(() => {});
  const keyVecs = await embedMany(
    CHUNK_CORPUS.map((c) => c.natKey),
    "dense",
  );
  const index = CHUNK_CORPUS.map((c, i) => ({ ...c, embedding: keyVecs[i] }));
  const chunkById = new Map(index.map((c) => [c.id, c]));

  const manifest = buildSpanIndexManifest(CHUNK_CORPUS);
  const spanVecs = await embedMany(
    manifest.map((m) => m.text),
    "dense",
  );
  const spanIndex = manifest.map((m, i) => ({
    ...m,
    embedding: spanVecs[i],
  }));

  console.log(`span index entries: ${spanIndex.length}`);
  console.log(
    `  author: ${spanIndex.filter((e) => e.kind === "author").length}`,
  );
  console.log(
    `  key-span: ${spanIndex.filter((e) => e.kind === "key-span").length}`,
  );

  for (const [label, cases] of [
    ["focus", FOCUS_CASES],
    ["mech2", MECH2_CASES],
    ["baseline", BASELINE_CASES],
  ]) {
    const key = await evalMode("natKey", cases, index, spanIndex, chunkById);
    const dual = await evalMode("dual", cases, index, spanIndex, chunkById);
    console.log(`\n=== ${label} ===`);
    console.log(`natKey-only: ${key.ok}/${key.total}`);
    console.log(
      `dual-index: ${dual.ok}/${dual.total} (+${dual.ok - key.ok} vs natKey)`,
    );
    if (dual.fails.length) console.log("dual fails:", dual.fails);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
