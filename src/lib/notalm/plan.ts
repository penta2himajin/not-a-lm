/**
 * G5 — operation planner + renderer (copy-only, closed glue).
 *
 * Planner builds a declarative OperationPlan (steps). Renderer turns steps into
 * reply text. No token generation: every substring is a corpus span copy, a
 * closed opener/connector, or a topic phrase copied from the query.
 *
 * G5a: behavior-identical extraction of engine Stage 3–4 branching.
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
import type {
  ChunkRecord,
  ComposePlan,
  FusePartTrace,
  Lang,
  OpStep,
  OperationPlan,
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
): "as-is" | "negate-correct" | "affirm-confirm" | "fuse" | "compose" {
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

  if (chunk.spans?.length) {
    const composeCtx: ComposeContext = {
      prefix: composePrefix,
      focusSpanId,
      focusKeySpanText,
    };
    if (query) {
      composeCtx.spanRankings = await rankSpansForCompose(query, chunk.spans);
      composeCtx.spanNliRankings = await rankSpansByNli(query, chunk.spans);
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
    };
  }

  return null;
}

/**
 * Build a fuse OperationPlan from segment→chunk parts (after bipartite match).
 * Runs G4 compose per part (same as former fuseCompound render path).
 */
export async function planFuseParts(
  parts: { seg: string; chunk: ChunkRecord }[],
  lang: Lang,
): Promise<OperationPlan | null> {
  if (parts.length < 2) return null;
  const steps: OpStep[] = [];
  const reasons = [`fuse:parts=${parts.length}`];

  for (let i = 0; i < parts.length; i++) {
    const { seg, chunk } = parts[i];
    if (i > 0) {
      steps.push({ kind: "glue", template: "topic", topic: seg });
    }
    const { plan } = await composePartBodyPlan(seg, chunk, lang);
    if (plan) reasons.push(`fuse[${i}]:compose`);
    steps.push({
      kind: "body",
      chunkId: chunk.id,
      composePlan: plan ?? undefined,
      stripFiller: i > 0,
    });
  }

  // Restore first-part segment in fuseParts compatibility via reasons only;
  // engine will rebuild fuseParts with segments from parts[].
  return { steps, reasons };
}

/** Compose-only helper used by fuse planner (avoids circular engine deps). */
async function composePartBodyPlan(
  segmentQuery: string,
  chunk: ChunkRecord,
  lang: Lang,
): Promise<{ plan: ComposePlan | null }> {
  if (!chunk.spans?.length) return { plan: null };
  const spanRankings = await rankSpansForCompose(segmentQuery, chunk.spans);
  const spanNliRankings = await rankSpansByNli(segmentQuery, chunk.spans);
  const plan = planComposeG4a(segmentQuery, chunk, {
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
