/**
 * G6a TurnGrounding unit eval.
 * Run: npm run eval:g6a
 */
import {
  buildTurnGrounding,
  formatTurnGrounding,
  lastBotGrounding,
  recentBotGroundings,
} from "../src/lib/notalm/grounding.ts";
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

{
  const c = chunk("mech-rag-a", "ja");
  const g = buildTurnGrounding({
    chunk: c,
    operation: "compose",
    composePlan: {
      prefix: "negate-correct",
      kept: [{ chunkId: c.id, spanId: "no-gen" }],
    },
  });
  check("claim", g.claim === "mech-rag-a");
  check("kept", g.kept?.length === 1 && g.kept[0].spanId === "no-gen");
  const noGen = c.spans.find((s) => s.id === "no-gen");
  check(
    "excerpt from span",
    g.excerptTexts.length === 1 && g.excerptTexts[0] === noGen.text,
  );
  check(
    "format",
    formatTurnGrounding(g).includes("mech-rag-a") &&
      formatTurnGrounding(g).includes("no-gen"),
  );
}

{
  const c = chunk("mech-1", "ja");
  const g = buildTurnGrounding({ chunk: c, operation: "as-is" });
  check("no kept → full value excerpt", g.excerptTexts[0] === c.value);
}

{
  const rag = chunk("mech-rag-a", "ja");
  const prior = chunk("mech-existing", "ja");
  const g = buildTurnGrounding({
    chunk: rag,
    operation: "fuse",
    fuseParts: [
      { chunkId: rag.id, segment: "RAG", composePlan: undefined },
      {
        chunkId: prior.id,
        segment: "既存",
        composePlan: {
          kept: [{ chunkId: prior.id, spanId: "item-retrieval" }],
        },
      },
    ],
    getChunk: (id) => CHUNK_CORPUS.find((x) => x.id === id),
  });
  check("fuse parts", g.parts?.length === 1 && g.parts[0].claim === "mech-existing");
  check(
    "fuse part excerpt",
    !!g.parts?.[0].excerptTexts[0]?.includes("retrieval"),
  );
}

{
  const c = chunk("who-1", "ja");
  const g = buildTurnGrounding({ chunk: c });
  const history = [
    { id: "u1", role: "user", text: "誰？" },
    {
      id: "b1",
      role: "bot",
      text: c.value,
      sourceChunkId: c.id,
      grounding: g,
    },
    { id: "u2", role: "user", text: "それは？" },
  ];
  check("lastBotGrounding", lastBotGrounding(history)?.chunkId === c.id);
  check("recentBotGroundings", recentBotGroundings(history, 3).length === 1);
  check(
    "no prior when empty",
    lastBotGrounding([{ id: "u", role: "user", text: "hi" }]) == null,
  );
}

console.log(`\ng6a: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
