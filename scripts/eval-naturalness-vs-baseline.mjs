/**
 * Compare current live replies to a frozen naturalness baseline.
 *
 * Protocol:
 *   A = current live reply (same prompts as baseline)
 *   B = frozen baseline.liveReply
 * Pairwise judge with position debias.
 *
 * Expectation after corpus improvements: A wins or ties (no regression).
 *
 * Usage:
 *   NOTALM_URL=http://127.0.0.1:43123 npm run eval:naturalness-vs-baseline
 *   npm run eval:naturalness-vs-baseline -- --baseline=fixtures/naturalness-judge/baselines/pre-s3-2026-09-05.json
 *   npm run eval:naturalness-vs-baseline -- --limit=5
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { judgePairwise } from "../src/lib/notalm/naturalness-judge.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const BASE = process.env.NOTALM_URL ?? "http://127.0.0.1:43123";

const baselineArg = process.argv.find((a) => a.startsWith("--baseline="));
const baselinePath = resolve(
  root,
  baselineArg?.slice("--baseline=".length) ??
    "fixtures/naturalness-judge/baselines/pre-s3-2026-09-05.json",
);
const outArg = process.argv.find((a) => a.startsWith("--out="));
const outPath = resolve(
  outArg?.slice("--out=".length) ??
    "/opt/cursor/artifacts/naturalness_vs_baseline.json",
);

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

/** Replay prior turns so bot grounding is attached (needed for proximal pin). */
async function liveHistory(turns) {
  if (!turns?.length) return [];
  const hist = [];
  for (const t of turns) {
    if (t.role === "user") {
      hist.push({ id: `h${hist.length}`, role: "user", text: t.text });
    } else if (t.role === "bot") {
      // Prefer re-asking the previous user turn to get live grounding.
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

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
if (!Array.isArray(baseline.cases) || baseline.cases.length < 20) {
  console.warn(
    `warning: baseline has ${baseline.cases?.length ?? 0} cases; prefer ≥20 (pre-s3 set)`,
  );
}
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : Infinity;
const cases = baseline.cases.slice(
  0,
  Number.isFinite(limit) ? limit : baseline.cases.length,
);
const report = {
  baselineId: baseline.id,
  baselinePath,
  judgeModel: null,
  comparedAt: new Date().toISOString(),
  cases: [],
  summary: { improved: 0, tied: 0, regressed: 0, skipped: 0 },
};

console.log(
  `baseline=${baseline.id} cases=${cases.length}/${baseline.cases.length} url=${BASE}`,
);

for (const c of cases) {
  if (!c.user || !c.liveReply) {
    console.log(`[${c.id}] skip (missing user/liveReply)`);
    report.summary.skipped++;
    continue;
  }
  process.stdout.write(`[${c.id}] fetching live… `);
  const hist = await liveHistory(c.history);
  const res = await chat(c.user, hist, hist.length === 0);
  const live = res.message?.text ?? "";
  const meta = {
    claim: res.message?.grounding?.claim ?? res.trace?.chosen?.chunk?.claim,
    op: res.trace?.operation ?? res.trace?.op,
    anaphora: res.trace?.anaphora,
  };
  console.log(`live="${live.slice(0, 60)}"`);

  if (live.trim() === c.liveReply.trim()) {
    console.log(`  unchanged vs baseline → treat as tie (skip judge)`);
    report.cases.push({
      id: c.id,
      user: c.user,
      baselineReply: c.liveReply,
      liveReply: live,
      liveMeta: meta,
      winner: "tie",
      reason: "byte-identical",
      votes: { A: 0, B: 0, tie: 1 },
    });
    report.summary.tied++;
    continue;
  }

  const agg = await judgePairwise(
    {
      id: `vs-baseline:${c.id}`,
      lang: "ja",
      context: (c.history ?? []).map((t) => ({
        role: t.role === "bot" ? "bot" : "user",
        text: t.text,
      })),
      user: c.user,
      replyA: live,
      replyB: c.liveReply,
      notes: "A=current live, B=frozen pre-S2 baseline",
    },
    { debias: true },
  );
  report.judgeModel = agg.model;
  // A win = improved (or at least preferred now); B win = regression
  if (agg.winner === "A") report.summary.improved++;
  else if (agg.winner === "B") report.summary.regressed++;
  else report.summary.tied++;

  console.log(
    `  winner=${agg.winner} votes(A=${agg.votes.A} B=${agg.votes.B} tie=${agg.votes.tie})`,
  );
  for (const p of agg.passes) {
    console.log(
      `  pass swap=${p.positionSwapped} -> ${p.winner}: ${p.rationale}`,
    );
  }
  report.cases.push({
    id: c.id,
    user: c.user,
    baselineReply: c.liveReply,
    liveReply: live,
    liveMeta: meta,
    winner: agg.winner,
    votes: agg.votes,
    rationales: agg.passes.map((p) => ({
      swap: p.positionSwapped,
      winner: p.winner,
      rationale: p.rationale,
    })),
  });
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
console.log("\n=== SUMMARY (A=current, B=baseline) ===");
console.log(JSON.stringify(report.summary, null, 2));
console.log(`wrote ${outPath}`);
if (report.summary.regressed > 0) process.exitCode = 1;
