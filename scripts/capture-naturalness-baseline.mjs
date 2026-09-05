/**
 * Capture live replies for naturalness baseline cases and optionally
 * pairwise-judge against stiff/drift/abrupt comparators.
 *
 * Usage:
 *   NOTALM_URL=http://127.0.0.1:43123 node --experimental-strip-types \
 *     scripts/capture-naturalness-baseline.mjs
 *   ... --out=fixtures/naturalness-judge/baselines/pre-s3-2026-09-05.json
 *   ... --skip-judge   # capture live only
 *   ... --limit=5
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { judgePairwise } from "../src/lib/notalm/naturalness-judge.ts";
import {
  BASELINE_CASE_DEFS,
  MIN_CASE_COUNT,
} from "./naturalness-baseline-cases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const BASE = process.env.NOTALM_URL ?? "http://127.0.0.1:43123";

const outArg = process.argv.find((a) => a.startsWith("--out="));
const outPath = resolve(
  outArg?.slice("--out=".length) ??
    "fixtures/naturalness-judge/baselines/pre-s3-2026-09-05.json",
);
const skipJudge = process.argv.includes("--skip-judge");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg
  ? Number(limitArg.slice("--limit=".length))
  : Infinity;

async function chat(userText, history = [], resetSession = true) {
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userText, history, generate: true, resetSession }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function liveHistory(turns) {
  if (!turns?.length) return [];
  const hist = [];
  for (const t of turns) {
    if (t.role === "user") {
      hist.push({ id: `h${hist.length}`, role: "user", text: t.text });
    } else if (t.role === "bot") {
      const prevUser = [...hist].reverse().find((m) => m.role === "user");
      if (prevUser) {
        const seed = await chat(
          prevUser.text,
          hist.slice(0, -1),
          hist.length <= 1,
        );
        hist.push({
          id: seed.message?.id ?? `h${hist.length}`,
          role: "bot",
          text: seed.message?.text ?? t.text,
          grounding: seed.message?.grounding,
        });
      } else {
        hist.push({ id: `h${hist.length}`, role: "bot", text: t.text });
      }
    }
  }
  return hist;
}

function gitMeta() {
  try {
    return {
      gitCommit: execSync("git rev-parse HEAD", { cwd: root })
        .toString()
        .trim(),
      branch: execSync("git rev-parse --abbrev-ref HEAD", { cwd: root })
        .toString()
        .trim(),
    };
  } catch {
    return { gitCommit: "unknown", branch: "unknown" };
  }
}

const defs = BASELINE_CASE_DEFS.slice(
  0,
  Number.isFinite(limit) ? limit : BASELINE_CASE_DEFS.length,
);
if (defs.length < MIN_CASE_COUNT && !Number.isFinite(limit)) {
  console.error(
    `need ≥${MIN_CASE_COUNT} case defs, got ${defs.length}`,
  );
  process.exit(1);
}

const { gitCommit, branch } = gitMeta();
const cases = [];
let judgeModel = null;

console.log(
  `capturing ${defs.length} cases from ${BASE} skipJudge=${skipJudge}`,
);

for (const def of defs) {
  process.stdout.write(`[${def.id}] `);
  const hist = await liveHistory(def.history);
  const res = await chat(def.user, hist, hist.length === 0);
  const liveReply = res.message?.text ?? "";
  const liveMeta = {
    text: liveReply,
    claim: res.message?.grounding?.claim ?? res.trace?.chosen?.chunk?.claim,
    op: res.trace?.operation ?? res.trace?.op,
    anaphora:
      res.trace?.anaphora ?? res.trace?.debug?.anaphora ?? "none",
  };
  console.log(
    `live="${liveReply.slice(0, 48)}" claim=${liveMeta.claim ?? "?"} op=${liveMeta.op ?? "?"}`,
  );

  const row = {
    id: def.id,
    tags: def.tags,
    notes: def.notes,
    user: def.user,
    history: def.history ?? [],
    liveReply,
    comparatorReply: def.comparatorReply,
    comparatorRole: def.comparatorRole,
    liveMeta,
  };

  if (!skipJudge && def.comparatorReply) {
    const agg = await judgePairwise(
      {
        id: `capture:${def.id}`,
        lang: "ja",
        context: (def.history ?? []).map((t) => ({
          role: t.role === "bot" ? "bot" : "user",
          text: t.text,
        })),
        user: def.user,
        replyA: liveReply,
        replyB: def.comparatorReply,
        notes: def.notes,
      },
      { debias: true },
    );
    judgeModel = agg.model;
    row.winnerAtCapture = agg.winner;
    row.votesAtCapture = agg.votes;
    console.log(
      `  judge winner=${agg.winner} votes(A=${agg.votes.A} B=${agg.votes.B} tie=${agg.votes.tie})`,
    );
  }

  cases.push(row);
}

const baseline = {
  id: "naturalness-baseline-pre-s3",
  capturedAt: new Date().toISOString(),
  gitCommit,
  branch,
  note:
    "Expanded ≥20-case naturalness baseline before S3. Captured from live API; pairwise vs stiff/drift/abrupt comparators. Use for corpus/behavior regression after S3.",
  supersedes: "naturalness-baseline-pre-s2",
  judgeModel,
  protocol: {
    pairwise: "A=live system reply, B=comparator (stiff/ideal/drift/abrupt)",
    debias: true,
    dimensions: ["tempo", "coherence", "humanlikeness"],
    compareLater:
      "Re-fetch live with same prompts; pairwise A=new live vs B=frozen liveReply. Expect A wins or tie (no regression).",
    minCases: MIN_CASE_COUNT,
  },
  cases,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(baseline, null, 2) + "\n");
console.log(`\nwrote ${outPath} cases=${cases.length}`);
if (cases.length < MIN_CASE_COUNT) {
  console.warn(`warning: fewer than ${MIN_CASE_COUNT} cases`);
  process.exitCode = 1;
}
