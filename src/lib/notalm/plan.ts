/**
 * G5 — operation planner + renderer (copy-only, closed glue).
 *
 * Planner builds a declarative OperationPlan (steps). Renderer turns steps into
 * reply text. No token generation: every substring is a corpus span copy, a
 * closed opener/connector, or a topic phrase copied from the query.
 *
 * G5a: behavior-identical extraction of engine Stage 3–4 branching.
 * G5d: score multiple candidate plans and pick the best (closed heuristic).
 */

import {
  composeChangesReply,
  planComposeG4a,
  rankSpansByNli,
  rankSpansForCompose,
  renderCompose,
  type ComposeContext,
} from "./compose.ts";
import { isNliReady, nliClassify, normalizeForNli } from "./nli.ts";
import { closedClarifyText } from "./grounding.ts";
import type {
  ChunkRecord,
  ComposePlan,
  FusePartTrace,
  Lang,
  OpStep,
  OperationPlan,
  PlanCandidate,
  PlanCandidateSignals,
} from "./types.ts";

/** Min NLI entailment to treat a query as presupposing the assertion */
export const NLI_ENTAIL_MIN = 0.5;

/** Closed-set negation openers per language. */
export const NEGATION_OPENER: Record<Lang, string> = {
  ja: "いいえ、そうではありません。",
  en: "No, that's not the case. ",
  zh: "不，并不是这样。",
};

/** Closed-set affirmation openers. */
export const AFFIRM_OPENER: Record<Lang, string> = {
  ja: "はい、その通りです。",
  en: "Yes, exactly. ",
  zh: "对，正是如此。",
};

export const GROUNDED_OPENERS = {
  negation: NEGATION_OPENER,
  affirm: AFFIRM_OPENER,
};

/**
 * Fluent topic connector for fusion: topic is copied from the query; only the
 * particle/preposition is closed-set glue.
 */
export function topicConnector(lang: Lang, topic: string): string {
  if (lang === "ja") return `${topic}については、`;
  if (lang === "zh") return `至于${topic}，`;
  return ` As for ${topic}, `;
}

const STRIP_LEADS: Record<Lang, string[]> = {
  ja: ["あるよ。", "あるよ", "うん、", "うん。", "はい、", "はい。", "ええ、", "そうだね。"],
  en: ["Sure. ", "Sure, ", "Sure — ", "Yes. ", "Yes, ", "Yeah. ", "Yeah, ", "Well, "],
  zh: ["有的。", "有的，", "有。", "是的。", "对，", "嗯，"],
};

/** Extractive deletion of closed leading fillers after a topic lead-in. */
export function stripLeadingFiller(value: string, lang: Lang): string {
  const v = value.trimStart();
  for (const lead of STRIP_LEADS[lang]) {
    if (v.startsWith(lead)) return v.slice(lead.length).trimStart();
  }
  return v;
}

/** Legacy trace label derived from steps (keep until callers migrate to plan). */
export function deriveOperationLabel(
  plan: OperationPlan,
): "as-is" | "negate-correct" | "affirm-confirm" | "fuse" | "compose" | "clarify" {
  if (plan.steps.some((s) => s.kind === "closed" || s.kind === "echo")) {
    return "clarify";
  }
  const hasGlue = plan.steps.some((s) => s.kind === "glue");
  if (hasGlue) return "fuse";
  const body = plan.steps.find((s) => s.kind === "body");
  if (body?.kind === "body" && body.composePlan) return "compose";
  const prefix = plan.steps.find((s) => s.kind === "prefix");
  if (prefix?.kind === "prefix") return prefix.which;
  return "as-is";
}

/** Legacy fuseParts[] from a fuse OperationPlan. */
export function fusePartsFromPlan(plan: OperationPlan): FusePartTrace[] {
  const parts: FusePartTrace[] = [];
  let pendingTopic: string | undefined;
  for (const step of plan.steps) {
    if (step.kind === "glue" && step.template === "topic") {
      pendingTopic = step.topic;
      continue;
    }
    if (step.kind === "body") {
      parts.push({
        chunkId: step.chunkId,
        segment: pendingTopic ?? "",
        composePlan: step.composePlan,
      });
      pendingTopic = undefined;
    }
  }
  // First part has empty segment in current fuseParts; fill from reasons if needed.
  // Engine historically stores the segment string for each part including the first.
  return parts;
}

export function fusedWithFromPlan(plan: OperationPlan): string {
  const ids = plan.steps
    .filter((s): s is Extract<OpStep, { kind: "body" }> => s.kind === "body")
    .map((s) => s.chunkId);
  return ids.slice(1).join(",");
}

export function fusedComposeFromPlan(plan: OperationPlan): boolean {
  return plan.steps.some(
    (s) => s.kind === "body" && s.composePlan != null,
  );
}

export function primaryComposePlan(plan: OperationPlan): ComposePlan | undefined {
  if (deriveOperationLabel(plan) !== "compose") return undefined;
  const body = plan.steps.find((s) => s.kind === "body");
  return body?.kind === "body" ? body.composePlan : undefined;
}

/**
 * Render an OperationPlan to reply text. Pure aside from looking up chunks.
 */
export function renderOperationPlan(
  plan: OperationPlan,
  getChunk: (id: string) => ChunkRecord | undefined,
  lang: Lang,
  openers: {
    negation: Record<Lang, string>;
    affirm: Record<Lang, string>;
  } = GROUNDED_OPENERS,
): string {
  let out = "";
  let pendingPrefix: "negate-correct" | "affirm-confirm" | undefined;

  for (const step of plan.steps) {
    if (step.kind === "prefix") {
      pendingPrefix = step.which;
      continue;
    }
    if (step.kind === "glue") {
      out += topicConnector(lang, step.topic);
      continue;
    }
    if (step.kind === "closed") {
      out += closedClarifyText(step.which, lang);
      continue;
    }
    if (step.kind === "echo") {
      out += step.text;
      continue;
    }
    // body
    const chunk = getChunk(step.chunkId);
    if (!chunk) continue;

    let body: string;
    if (step.composePlan) {
      const cp: ComposePlan = {
        ...step.composePlan,
        prefix: step.composePlan.prefix ?? pendingPrefix,
      };
      body = renderCompose(cp, chunk, lang, openers);
      pendingPrefix = undefined;
    } else if (pendingPrefix) {
      body =
        (pendingPrefix === "negate-correct"
          ? openers.negation[lang]
          : openers.affirm[lang]) + chunk.value;
      pendingPrefix = undefined;
    } else {
      body = chunk.value;
    }

    if (step.stripFiller) body = stripLeadingFiller(body, lang);
    out += body;
  }

  return out;
}

export type PolarityPeek = {
  prefix?: "negate-correct" | "affirm-confirm";
  nliLabel?: string;
  nliScore?: number;
  nliRan: boolean;
  reasons: string[];
};

/** Run chunk-level NLI only (used to decide fuse vs single before planning). */
export async function peekPolarity(
  query: string,
  chunk: ChunkRecord,
): Promise<PolarityPeek> {
  const reasons: string[] = [];
  if (!isNliReady() || !query || !chunk.assertions?.length || !chunk.stance) {
    return { nliRan: false, reasons };
  }
  try {
    const premise = normalizeForNli(query);
    let bestEntail = -1;
    let bestLabel = "neutral";
    for (const assertion of chunk.assertions) {
      const nli = await nliClassify(premise, assertion);
      if (nli.entail > bestEntail) {
        bestEntail = nli.entail;
        bestLabel = nli.label;
      }
    }
    reasons.push(`nli:${bestLabel}@${bestEntail.toFixed(2)}`);
    let prefix: "negate-correct" | "affirm-confirm" | undefined;
    if (bestEntail >= NLI_ENTAIL_MIN) {
      if (chunk.stance === "deny") {
        prefix = "negate-correct";
        reasons.push("prefix:negate-correct");
      } else if (chunk.stance === "affirm") {
        prefix = "affirm-confirm";
        reasons.push("prefix:affirm-confirm");
      }
    }
    return {
      prefix,
      nliLabel: bestLabel,
      nliScore: bestEntail,
      nliRan: true,
      reasons,
    };
  } catch {
    return { nliRan: false, reasons };
  }
}

export type SingleChunkPlanInput = {
  query: string;
  chunk: ChunkRecord;
  lang: Lang;
  /** Dual-index author span focus */
  focusSpanId?: string;
  focusKeySpanText?: string;
  /** Skip re-running NLI when peekPolarity already ran */
  polarity?: PolarityPeek;
};

export type SingleChunkPlanResult = {
  plan: OperationPlan;
  nliLabel?: string;
  nliScore?: number;
  /** P0: ms spent re-embedding spans for compose rank */
  spanEmbedMs?: number;
  /** P0: ms spent per-span NLI hypotheses */
  spanNliMs?: number;
};

/**
 * G5a single-chunk planner: NLI polarity → optional G4 compose → OperationPlan.
 * Returns null when grounded generation should leave the raw value (no label).
 */
export async function planSingleChunk(
  input: SingleChunkPlanInput,
): Promise<SingleChunkPlanResult | null> {
  const { query, chunk, lang, focusSpanId, focusKeySpanText } = input;
  const polarity = input.polarity ?? (await peekPolarity(query, chunk));
  const reasons = [...polarity.reasons];
  const composePrefix = polarity.prefix;
  const nliLabel = polarity.nliLabel;
  const nliScore = polarity.nliScore;
  const nliRan = polarity.nliRan;
  let spanEmbedMs: number | undefined;
  let spanNliMs: number | undefined;

  if (chunk.spans?.length) {
    const composeCtx: ComposeContext = {
      prefix: composePrefix,
      focusSpanId,
      focusKeySpanText,
    };
    if (query) {
      const tEmbed = performance.now();
      composeCtx.spanRankings = await rankSpansForCompose(query, chunk.spans);
      spanEmbedMs = Math.round(performance.now() - tEmbed);
      const tNli = performance.now();
      composeCtx.spanNliRankings = await rankSpansByNli(query, chunk.spans);
      spanNliMs = Math.round(performance.now() - tNli);
    }
    const g4 = planComposeG4a(query, chunk, composeCtx);
    if (
      g4 &&
      composeChangesReply(g4, chunk, lang, GROUNDED_OPENERS)
    ) {
      reasons.push(
        `compose:kept=${g4.kept.map((k) => k.spanId).join("+")}`,
      );
      return {
        plan: {
          steps: [
            {
              kind: "body",
              chunkId: chunk.id,
              composePlan: g4,
            },
          ],
          reasons,
        },
        nliLabel,
        nliScore,
        spanEmbedMs,
        spanNliMs,
      };
    }
  }

  if (composePrefix) {
    return {
      plan: {
        steps: [
          { kind: "prefix", which: composePrefix },
          { kind: "body", chunkId: chunk.id },
        ],
        reasons,
      },
      nliLabel,
      nliScore,
      spanEmbedMs,
      spanNliMs,
    };
  }

  if (nliRan) {
    reasons.push("as-is");
    return {
      plan: {
        steps: [{ kind: "body", chunkId: chunk.id }],
        reasons,
      },
      nliLabel,
      nliScore,
      spanEmbedMs,
      spanNliMs,
    };
  }

  return null;
}

/**
 * Build a fuse OperationPlan from segment→chunk parts (after bipartite match).
 * G5c: per-segment NLI polarity + G4 compose (polarity×fuse coexistence).
 */
export async function planFuseParts(
  parts: { seg: string; chunk: ChunkRecord }[],
  lang: Lang,
): Promise<{
  plan: OperationPlan;
  nliLabel?: string;
  nliScore?: number;
} | null> {
  if (parts.length < 2) return null;
  const steps: OpStep[] = [];
  const reasons = [`fuse:parts=${parts.length}`];
  let bestLabel: string | undefined;
  let bestScore = -1;

  for (let i = 0; i < parts.length; i++) {
    const { seg, chunk } = parts[i];
    if (i > 0) {
      steps.push({ kind: "glue", template: "topic", topic: seg });
    }

    const polarity = await peekPolarity(seg, chunk);
    if (polarity.nliRan && (polarity.nliScore ?? -1) > bestScore) {
      bestScore = polarity.nliScore ?? -1;
      bestLabel = polarity.nliLabel;
    }
    for (const r of polarity.reasons) {
      reasons.push(`fuse[${i}]:${r}`);
    }

    const { plan } = await composePartBodyPlan(
      seg,
      chunk,
      lang,
      polarity.prefix,
    );
    if (plan) {
      reasons.push(`fuse[${i}]:compose`);
      steps.push({
        kind: "body",
        chunkId: chunk.id,
        composePlan: plan,
        stripFiller: i > 0,
      });
    } else if (polarity.prefix) {
      steps.push({ kind: "prefix", which: polarity.prefix });
      steps.push({
        kind: "body",
        chunkId: chunk.id,
        stripFiller: i > 0,
      });
    } else {
      steps.push({
        kind: "body",
        chunkId: chunk.id,
        stripFiller: i > 0,
      });
    }
  }

  return {
    plan: { steps, reasons },
    nliLabel: bestLabel,
    nliScore: bestScore >= 0 ? bestScore : undefined,
  };
}

/** Compose helper for fuse planner; optional polarity prefix (G5c). */
async function composePartBodyPlan(
  segmentQuery: string,
  chunk: ChunkRecord,
  lang: Lang,
  prefix?: "negate-correct" | "affirm-confirm",
): Promise<{ plan: ComposePlan | null }> {
  if (!chunk.spans?.length) return { plan: null };
  const spanRankings = await rankSpansForCompose(segmentQuery, chunk.spans);
  const spanNliRankings = await rankSpansByNli(segmentQuery, chunk.spans);
  const plan = planComposeG4a(segmentQuery, chunk, {
    prefix,
    spanRankings,
    spanNliRankings,
  });
  if (!plan || !composeChangesReply(plan, chunk, lang, GROUNDED_OPENERS)) {
    return { plan: null };
  }
  return { plan };
}

/** Rebuild legacy fuseParts with real segment strings (first included). */
export function fusePartsFromMatched(
  parts: { seg: string; chunk: ChunkRecord }[],
  plan: OperationPlan,
): FusePartTrace[] {
  const bodies = plan.steps.filter(
    (s): s is Extract<OpStep, { kind: "body" }> => s.kind === "body",
  );
  return parts.map((p, i) => ({
    chunkId: p.chunk.id,
    segment: p.seg,
    composePlan: bodies[i]?.composePlan,
  }));
}

/** Short label for one OpStep (trace UI / logs). */
export function formatOpStep(step: OpStep): string {
  if (step.kind === "prefix") {
    return step.which === "negate-correct" ? "¬" : "✓";
  }
  if (step.kind === "glue") {
    const t = step.topic.length > 12 ? `${step.topic.slice(0, 12)}…` : step.topic;
    return `glue(${t})`;
  }
  if (step.kind === "closed") {
    return step.which === "clarify-open"
      ? "clarify?"
      : step.which === "clarify-close"
        ? "ask"
        : "·";
  }
  if (step.kind === "echo") {
    const t = step.text.length > 16 ? `${step.text.slice(0, 16)}…` : step.text;
    return `echo(${t})`;
  }
  const spans = step.composePlan?.kept?.map((k) => k.spanId).join("+");
  const prefix = step.composePlan?.prefix
    ? step.composePlan.prefix === "negate-correct"
      ? "¬"
      : "✓"
    : "";
  const id = step.chunkId.replace(/-ja$|-en$|-zh$/, "");
  return spans ? `${prefix}body(${id}/${spans})` : `${prefix}body(${id})`;
}

/** One-line plan summary for traces. */
export function formatOperationPlan(plan: OperationPlan): string {
  return plan.steps.map(formatOpStep).join(" → ");
}

/** Derive G5d scoring signals from a plan (+ optional relevance/NLI). */
export function planSignals(
  plan: OperationPlan,
  opts: { relevance: number; nliEntail?: number },
): PlanCandidateSignals {
  const bodies = plan.steps.filter((s) => s.kind === "body").length;
  const hasCompose = plan.steps.some(
    (s) => s.kind === "body" && s.composePlan != null,
  );
  const hasPolarity =
    plan.steps.some((s) => s.kind === "prefix") ||
    plan.steps.some(
      (s) => s.kind === "body" && s.composePlan?.prefix != null,
    );
  return {
    relevance: opts.relevance,
    nliEntail: opts.nliEntail,
    bodies,
    hasCompose,
    hasPolarity,
  };
}

/**
 * G5d closed heuristic score. Higher = better grounded recipe.
 * Relevance (gate / fuse-part mean) dominates; multi-body fuse gets a mild
 * boost only when those parts are actually strong. Compose + polarity add
 * small bonuses so a focused single can beat a weak fuse.
 */
export function scorePlanCandidate(candidate: PlanCandidate): number {
  const { relevance, nliEntail = 0, bodies, hasCompose, hasPolarity } =
    candidate.signals;
  const bodyFactor = 1 + 0.35 * Math.max(0, bodies - 1);
  let score = 2.0 * relevance * bodyFactor;
  if (hasCompose) score += 0.35;
  if (hasPolarity) {
    score += 0.4 * Math.max(nliEntail, NLI_ENTAIL_MIN);
  } else if (nliEntail > 0) {
    score += 0.1 * nliEntail;
  }
  return score;
}

export type PlanSelection = {
  winner: PlanCandidate;
  ranked: PlanCandidate[];
};

/**
 * Score candidates and pick the highest. Annotates winner.plan.reasons with
 * g5d:pick / g5d:rank for audit (G5b UI already shows reasons).
 */
export function selectBestPlan(candidates: PlanCandidate[]): PlanSelection | null {
  if (candidates.length === 0) return null;
  const ranked = candidates.map((c) => ({
    ...c,
    score: scorePlanCandidate(c),
  }));
  ranked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const winner = ranked[0];
  const rankStr = ranked
    .map((c) => `${c.id}@${(c.score ?? 0).toFixed(2)}`)
    .join(">");
  winner.plan = {
    ...winner.plan,
    reasons: [
      ...winner.plan.reasons,
      `g5d:pick=${winner.id}`,
      `g5d:rank=${rankStr}`,
    ],
  };
  return { winner, ranked };
}
