/**
 * G6 — multi-turn grounding helpers (copy-only).
 *
 * G6a: attach TurnGrounding to replies and read prior bot grounding from history.
 * G6b: proximal anaphora → inject prior excerpts; non-proximal → clarify plan.
 */

import type {
  ChatMessage,
  ChunkRecord,
  ComposePlan,
  FusePartTrace,
  Lang,
  OpStep,
  OperationPlan,
  SpanRef,
  TurnGrounding,
} from "./types.ts";

export type OperationLabel =
  | "as-is"
  | "negate-correct"
  | "affirm-confirm"
  | "fuse"
  | "compose"
  | "clarify";

export type AnaphoraClass = "none" | "proximal" | "non-proximal";

/** Closed clarify opener (no generation). */
export const CLARIFY_OPEN: Record<Lang, string> = {
  ja: "どれのことですか。たとえば最近だと、",
  en: "Which one do you mean? For example, recently: ",
  zh: "你说的是哪一个？比方说最近有：",
};

/** Separator between history excerpt examples. */
export const CLARIFY_SEP: Record<Lang, string> = {
  ja: "／",
  en: " / ",
  zh: "／",
};

/** Closed clarify closer. */
export const CLARIFY_CLOSE: Record<Lang, string> = {
  ja: "。それ以外なら、どんなものだったか思い出せる範囲で教えて。",
  en: ". If it's something else, tell me what you remember about it.",
  zh: "。如果是别的，请在想得起来的范围内告诉我是什么样的。",
};

export function closedClarifyText(
  which: "clarify-open" | "clarify-sep" | "clarify-close",
  lang: Lang,
): string {
  if (which === "clarify-open") return CLARIFY_OPEN[lang];
  if (which === "clarify-sep") return CLARIFY_SEP[lang];
  return CLARIFY_CLOSE[lang];
}

/**
 * Classify anaphora. Non-proximal is checked first so 「さっきの」does not
 * fall through to proximal markers inside the same utterance.
 */
export function classifyAnaphora(query: string, lang: Lang): AnaphoraClass {
  const q = query.trim();
  if (!q) return "none";

  if (lang === "ja") {
    if (
      /さっきの|先ほど|前に(?:言っ|話し|あっ)|以前の|前の話/.test(q)
    ) {
      return "non-proximal";
    }
    if (/(?:それ|その|これ|この|上記)/.test(q)) return "proximal";
    return "none";
  }

  if (lang === "zh") {
    if (/刚才|之前|上次|前面说/.test(q)) return "non-proximal";
    if (/那个|这个|上述|那是|这是/.test(q)) return "proximal";
    return "none";
  }

  // en: keep markers specific — bare "that"/"it" is too common
  if (
    /\b(earlier|previously|before that|the previous one)\b/i.test(q)
  ) {
    return "non-proximal";
  }
  if (/\b(that one|this one|about that|about this|the above)\b/i.test(q)) {
    return "proximal";
  }
  return "none";
}

/**
 * G6b-proximal: copy prior excerpt into the planning query (no generation).
 */
export function injectProximal(
  query: string,
  prior: TurnGrounding,
): { effectiveQuery: string; excerpt: string; reasons: string[] } {
  const excerpt = (prior.excerptTexts[0] ?? "").trim();
  if (!excerpt) {
    return {
      effectiveQuery: query,
      excerpt: "",
      reasons: ["g6b:proximal-empty"],
    };
  }
  return {
    effectiveQuery: `${excerpt} ${query}`.trim(),
    excerpt,
    reasons: [
      "g6b:proximal",
      `g6b:ref=${prior.claim ?? prior.chunkId}`,
    ],
  };
}

/**
 * G6b-clarify: closed opener/sep/close + echoed history excerpts.
 * Caller should only invoke when recent.length >= 2 (else proximal fallback).
 */
export function planClarifyRecent(
  recent: TurnGrounding[],
  lang: Lang,
): OperationPlan {
  const steps: OpStep[] = [{ kind: "closed", which: "clarify-open" }];
  const reasons = [`g6b:clarify`, `g6b:examples=${recent.length}`, `g6b:lang=${lang}`];
  let n = 0;
  for (let i = 0; i < recent.length; i++) {
    const text = (recent[i].excerptTexts[0] ?? "").trim();
    if (!text) continue;
    if (n > 0) steps.push({ kind: "closed", which: "clarify-sep" });
    steps.push({ kind: "echo", text });
    n++;
  }
  steps.push({ kind: "closed", which: "clarify-close" });
  return { steps, reasons };
}

function textsForKept(
  chunk: ChunkRecord | undefined,
  kept: SpanRef[] | undefined,
): string[] {
  if (!chunk) return [];
  if (kept?.length && chunk.spans?.length) {
    const out: string[] = [];
    for (const ref of kept) {
      if (ref.chunkId !== chunk.id) continue;
      const sp = chunk.spans.find((s) => s.id === ref.spanId);
      if (sp?.text) out.push(sp.text);
    }
    if (out.length) return out;
  }
  return chunk.value ? [chunk.value] : [];
}

/** Build grounding for the reply just produced (G6a). */
export function buildTurnGrounding(input: {
  chunk: ChunkRecord;
  operation?: OperationLabel;
  composePlan?: ComposePlan;
  fuseParts?: FusePartTrace[];
  getChunk?: (id: string) => ChunkRecord | undefined;
  excerptTextsOverride?: string[];
}): TurnGrounding {
  const { chunk, operation, composePlan, fuseParts, getChunk } = input;
  const kept = composePlan?.kept;
  const excerptTexts =
    input.excerptTextsOverride ?? textsForKept(chunk, kept);

  const parts: NonNullable<TurnGrounding["parts"]> = [];
  if (fuseParts?.length && getChunk) {
    for (const fp of fuseParts) {
      if (fp.chunkId === chunk.id) continue;
      const c = getChunk(fp.chunkId);
      if (!c) continue;
      parts.push({
        chunkId: c.id,
        claim: c.claim,
        excerptTexts: textsForKept(c, fp.composePlan?.kept),
      });
    }
  }

  return {
    chunkId: chunk.id,
    claim: chunk.claim,
    lang: chunk.lang as Lang,
    kept: kept?.filter((k) => k.chunkId === chunk.id),
    excerptTexts,
    operation,
    parts: parts.length ? parts : undefined,
  };
}

/** Last bot message that carries grounding (for proximal / clarify). */
export function lastBotGrounding(
  history: ChatMessage[],
): TurnGrounding | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "bot" && m.grounding) return m.grounding;
  }
  return undefined;
}

/** Recent bot groundings, newest first (for non-proximal clarify examples). */
export function recentBotGroundings(
  history: ChatMessage[],
  limit = 3,
): TurnGrounding[] {
  const out: TurnGrounding[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < limit; i--) {
    const m = history[i];
    if (m.role === "bot" && m.grounding) out.push(m.grounding);
  }
  return out;
}

/** One-line audit label for traces / UI. */
export function formatTurnGrounding(g: TurnGrounding): string {
  const claim = g.claim ?? g.chunkId.replace(/-ja$|-en$|-zh$/, "");
  const spans = g.kept?.map((k) => k.spanId).join("+");
  const op = g.operation && g.operation !== "as-is" ? g.operation : undefined;
  const bits = [claim];
  if (spans) bits.push(spans);
  if (op) bits.push(op);
  if (g.parts?.length) bits.push(`+${g.parts.length}`);
  return bits.join("/");
}

/** Reuse penalty magnitude (must match engine / dual-index). */
export const REUSE_PENALTY = 0.12;

/** Soft boost for same-claim (different chunk) continuity. */
export const CONTINUITY_CLAIM_BOOST = 0.06;

/**
 * G6c — hint derived from prior bot grounding so follow-ups can stick
 * to the same chunk/claim without fighting usedIds forever.
 */
export type ContinuityHint = {
  chunkId: string;
  claim?: string;
  keptSpanIds?: string[];
};

export function continuityFromPrior(
  prior?: TurnGrounding,
): ContinuityHint | undefined {
  if (!prior?.chunkId) return undefined;
  return {
    chunkId: prior.chunkId,
    claim: prior.claim,
    keptSpanIds: prior.kept?.map((k) => k.spanId),
  };
}

/**
 * Apply usedIds reuse penalty with G6c continuity relief/boost.
 * - Same prior chunk: waive reuse penalty (+ mild stick)
 * - Same claim, other chunk: small boost (still penalize if used)
 * - Otherwise: standard reuse penalty
 */
export function adjustScoreForContinuity(
  baseScore: number,
  chunk: { id: string; claim?: string },
  usedIds: Set<string>,
  continuity?: ContinuityHint,
  reusePenalty: number = REUSE_PENALTY,
): { score: number; notes: string[] } {
  let score = baseScore;
  const notes: string[] = [];
  const used = usedIds.has(chunk.id);
  const sameChunk = continuity?.chunkId === chunk.id;
  const sameClaim =
    Boolean(continuity?.claim) &&
    Boolean(chunk.claim) &&
    continuity!.claim === chunk.claim;

  if (used && sameChunk) {
    notes.push("g6c:reuse-waive");
    score += CONTINUITY_CLAIM_BOOST * 0.5;
    notes.push("g6c:chunk-continue");
  } else if (used) {
    score -= reusePenalty;
  }

  if (sameClaim && !sameChunk) {
    score += CONTINUITY_CLAIM_BOOST;
    notes.push("g6c:claim-boost");
  } else if (sameChunk && !used) {
    score += CONTINUITY_CLAIM_BOOST * 0.5;
    notes.push("g6c:chunk-stick");
  }

  return { score, notes };
}
