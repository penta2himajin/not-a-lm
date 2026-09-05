/**
 * Offline naturalness LLM-as-judge (OpenRouter).
 *
 * Requires: OPENROUTER_API_KEY
 * Optional: JUDGE_MODEL (default nvidia/nemotron-3-super-120b-a12b:free)
 *
 * Run:
 *   npm run eval:naturalness-judge
 *   JUDGE_MODEL=minimax/minimax-m2.7:free npm run eval:naturalness-judge
 *   npm run eval:naturalness-judge -- --no-debias
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_JUDGE_MODEL,
  judgePairwise,
} from "../src/lib/notalm/naturalness-judge.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const casesPath = join(
  __dirname,
  "../fixtures/naturalness-judge/cases.json",
);

const debias = !process.argv.includes("--no-debias");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : Infinity;

function check(name, ok, detail = "") {
  console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY is required");
    process.exit(1);
  }

  const cases = JSON.parse(readFileSync(casesPath, "utf8"));
  const selected = cases.slice(0, Number.isFinite(limit) ? limit : cases.length);

  console.log(
    `judge model default=${DEFAULT_JUDGE_MODEL} debias=${debias} cases=${selected.length}`,
  );

  let expectOk = 0;
  let expectTotal = 0;
  let ran = 0;

  for (const c of selected) {
    ran++;
    process.stdout.write(`\n[${c.id}] judging…\n`);
    try {
      const agg = await judgePairwise(c, { debias });
      const votes = `A=${agg.votes.A} B=${agg.votes.B} tie=${agg.votes.tie}`;
      const lat = agg.passes.map((p) => p.latencyMs).join("+");
      console.log(
        `  winner=${agg.winner} votes(${votes}) model=${agg.model} ms=${lat}`,
      );
      for (const p of agg.passes) {
        console.log(
          `  pass swap=${p.positionSwapped} -> ${p.winner}: ${p.rationale}`,
        );
      }
      if (c.expectWinner) {
        expectTotal++;
        if (
          check(
            `expect ${c.id}`,
            agg.winner === c.expectWinner,
            `got=${agg.winner} want=${c.expectWinner}`,
          )
        ) {
          expectOk++;
        }
      } else {
        check(`ran ${c.id}`, true, `winner=${agg.winner}`);
      }
    } catch (e) {
      check(`ran ${c.id}`, false, e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  }

  console.log(
    `\nsummary: ran=${ran} expect=${expectOk}/${expectTotal} model=${process.env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL}`,
  );
  if (expectTotal > 0 && expectOk < expectTotal) {
    process.exit(1);
  }
  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
