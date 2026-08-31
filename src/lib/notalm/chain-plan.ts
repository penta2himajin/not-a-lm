/**
 * G6d — declarative multi-turn chain plans (copy-only user turns; bot may generate).
 *
 * Replaces open-loop predict-user for the 連鎖デモ with an auditable recipe of
 * claim refs. Text always comes from corpus (user) or the existing reply path (bot).
 */

import { CHUNK_CORPUS } from "./corpus.ts";
import type {
  ChainPlan,
  ChainStep,
  ChunkRecord,
  Lang,
  Speaker,
} from "./types.ts";

/** Seed bot claim for the chain demo button. */
export const CHAIN_SEED_CLAIM = "chain-start";

/**
 * Ordered user-claim recipe after seed. Bot turns use resolve:"generate"
 * (freedom: G5/G6a–c still apply). Extend per language as needed.
 */
export const CHAIN_DEMO_USER_CLAIMS: Record<Lang, string[]> = {
  ja: [
    "chain-user-predict",
    "who-diff-q",
    "mech-rag-q",
    "hobby-q",
    "greet-howreply-q",
  ],
  en: [
    "chain-user-predict",
    "who-diff-q",
    "mech-rag-q",
    "hobby-q",
    "greet-howreply-q",
  ],
  zh: [
    "chain-user-predict",
    "who-diff-q",
    "mech-rag-q",
    "hobby-q",
    "greet-howreply-q",
  ],
};

export const CHAIN_SEED_USER_TEXT: Record<Lang, string> = {
  ja: "連鎖デモお願い",
  en: "Run a chain demo",
  zh: "请做连锁演示",
};

export function findChunkByClaim(
  claim: string,
  lang: Lang,
  speaker?: Speaker,
): ChunkRecord | undefined {
  return CHUNK_CORPUS.find(
    (c) =>
      c.claim === claim &&
      c.lang === lang &&
      (speaker == null || c.speaker === speaker),
  );
}

/**
 * Build a chain demo plan: for each pair, a corpus user turn + a generate bot turn.
 */
export function buildChainDemoPlan(opts: {
  lang: Lang;
  pairCount: number;
  /** Skip the first N user claims (resume / mid-chain). */
  userClaimOffset?: number;
}): ChainPlan {
  const pairCount = Math.max(1, Math.min(opts.pairCount, 8));
  const offset = Math.max(0, opts.userClaimOffset ?? 0);
  const recipe = CHAIN_DEMO_USER_CLAIMS[opts.lang] ?? CHAIN_DEMO_USER_CLAIMS.ja;
  const steps: ChainStep[] = [];
  const reasons = [
    `g6d:demo`,
    `g6d:lang=${opts.lang}`,
    `g6d:pairs=${pairCount}`,
    `g6d:offset=${offset}`,
  ];

  for (let i = 0; i < pairCount; i++) {
    const claim = recipe[(offset + i) % recipe.length];
    const userIdx = steps.length;
    steps.push({
      index: userIdx,
      role: "user",
      claim,
      resolve: "corpus",
      reason: `g6d:user-claim=${claim}`,
    });
    steps.push({
      index: userIdx + 1,
      role: "bot",
      resolve: "generate",
      reason: `g6d:bot-generate-after=${claim}`,
    });
  }

  return {
    id: `chain-demo-${opts.lang}-${pairCount}-${offset}`,
    lang: opts.lang,
    seedClaim: CHAIN_SEED_CLAIM,
    pairCount,
    steps,
    reasons,
  };
}

/** One-line plan summary for UI / logs. */
export function formatChainPlan(plan: ChainPlan): string {
  return plan.steps
    .map((s) => {
      if (s.role === "user") return `U:${s.claim ?? "?"}`;
      return s.resolve === "corpus" ? `B:${s.claim ?? "copy"}` : "B:gen";
    })
    .join(" → ");
}

/** Assert plan only references known claims / closed resolve vocab (eval). */
export function validateChainPlan(plan: ChainPlan): string[] {
  const errors: string[] = [];
  if (!plan.steps.length) errors.push("empty steps");
  for (const s of plan.steps) {
    if (s.resolve !== "corpus" && s.resolve !== "generate") {
      errors.push(`bad resolve@${s.index}`);
    }
    if (s.role === "user" && s.resolve === "corpus") {
      if (!s.claim) errors.push(`user missing claim@${s.index}`);
      else if (!findChunkByClaim(s.claim, plan.lang, "user")) {
        errors.push(`missing user chunk ${s.claim}/${plan.lang}`);
      }
    }
    if (s.role === "bot" && s.resolve === "corpus") {
      if (!s.claim) errors.push(`bot missing claim@${s.index}`);
      else if (!findChunkByClaim(s.claim, plan.lang, "bot")) {
        errors.push(`missing bot chunk ${s.claim}/${plan.lang}`);
      }
    }
  }
  return errors;
}
