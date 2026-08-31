/**
 * Validate author spans: value must equal joinSpanTexts(spans).
 * Run: node --experimental-strip-types scripts/eval-corpus-spans.mjs
 */
import { joinSpanTexts } from "../src/lib/notalm/compose.ts";
import { CHUNK_CORPUS } from "../src/lib/notalm/corpus.ts";

let ok = 0;
let total = 0;
const fails = [];

for (const chunk of CHUNK_CORPUS) {
  if (!chunk.spans?.length) continue;
  total++;
  const joined = joinSpanTexts(chunk.spans, chunk.lang);
  if (joined === chunk.value) {
    ok++;
  } else {
    fails.push({
      id: chunk.id,
      valueLen: chunk.value.length,
      joinedLen: joined.length,
      value: chunk.value.slice(0, 80),
      joined: joined.slice(0, 80),
    });
  }
}

console.log(`span/value consistency: ${ok}/${total}`);
if (fails.length) {
  console.log("fails:", fails);
  process.exit(1);
}

const claims = new Set(
  CHUNK_CORPUS.filter((c) => c.spans?.length).map((c) => c.claim),
);
console.log(`claims with spans: ${claims.size} (${[...claims].sort().join(", ")})`);
