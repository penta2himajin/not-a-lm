/**
 * One-shot: dump existing CHUNK_CORPUS into corpus/claims/*.yml
 * Run BEFORE switching corpus.ts to the YAML loader.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { CHUNK_CORPUS } from "../src/lib/notalm/corpus.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "corpus", "claims");
mkdirSync(outDir, { recursive: true });

/** @type {Map<string, any>} */
const byClaim = new Map();

for (const c of CHUNK_CORPUS) {
  let g = byClaim.get(c.claim);
  if (!g) {
    g = {
      claim: c.claim,
      speaker: c.speaker,
      tags: c.tags ?? [],
      stance: c.stance,
    };
    byClaim.set(c.claim, g);
  }
  const surface = {
    key: c.key,
    nat: c.natKey,
    value: c.value,
  };
  if (c.spans?.length) {
    surface.spans = c.spans.map((s) => {
      const sp = { id: s.id, text: s.text };
      if (s.tags?.length) sp.tags = s.tags;
      if (s.nliHypothesis) sp.nliHypothesis = s.nliHypothesis;
      return sp;
    });
  }
  if (c.assertions?.length) {
    surface.assertion =
      c.assertions.length === 1 ? c.assertions[0] : c.assertions;
  }
  g[c.lang] = surface;
}

let n = 0;
for (const [claim, g] of [...byClaim.entries()].sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  if (!g.stance) delete g.stance;
  const path = join(outDir, `${claim}.yml`);
  writeFileSync(path, stringify(g, { lineWidth: 100 }), "utf8");
  n++;
}

console.log(`migrated ${n} claims → ${outDir}`);
