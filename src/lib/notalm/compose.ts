/**
 * G4 — span-level grounded composition (copy-only, closed glue).
 *
 * Author-defined spans on a chunk are the atomic units. The G4a planner
 * selects which spans to KEEP (order preserved); renderCompose joins them with
 * closed-set glue. No token generation — every output substring is a copy of a
 * corpus span (plus optional closed prefix from G2).
 */

import type { ChunkRecord, ComposePlan, Lang, SpanRecord } from "./types";

/** Tags kept when a false presupposition triggered negate-correct (deny stance). */
const CORRECTION_TAGS = new Set(["correction", "no-generation", "deny-core"]);

/**
 * Query hints → span tag (G4a). Extend as corpus spans grow.
 * v1: substring / regex match on the full query (case-insensitive for Latin).
 */
const TAG_QUERY_HINTS: Record<string, RegExp[]> = {
  rag: [/rag/i, /ＲＡＧ/i],
  "no-generation": [/生成/, /generate/i, /生成/i, /无生成/],
  "prior-art": [/既存/, /prior art/i, /前例/, /类似/, /related work/i, /相关工作/i],
  "knn-lm": [/knn/i, /knn-lm/i],
  retro: [/retro/i],
  "retrieval-only": [/retrieval.only/i, /retrieval-only/i],
  "response-selection": [/response selection/i],
  "memory-networks": [/memory networks/i],
  mechanism: [/仕組み/, /原理/, /mechanism/i, /how does it work/i, /工作原理/, /怎么运作/],
  embedding: [/埋め込み/, /embedding/i, /嵌入/, /ベクトル/, /vector/i, /向量/],
  paraphrase: [/言い回し/, /wording/i, /措辞/, /paraphrase/i],
  code: [/コード/, /code/i, /编程/, /写代码/],
  consciousness: [/意識/, /conscious/i, /理解/, /思考/, /意识/],
};

export type ComposeContext = {
  /** From G2 NLI when grounded generation detected polarity */
  prefix?: "negate-correct" | "affirm-confirm";
  /** From dual-index retrieval: prefer this span in compose */
  focusSpanId?: string;
};

export function joinSpanTexts(spans: SpanRecord[], lang: Lang): string {
  if (spans.length === 0) return "";
  if (lang === "en") return spans.map((s) => s.text).join(" ");
  return spans.map((s) => s.text).join("");
}

function spanMatchesQuery(span: SpanRecord, query: string): boolean {
  if (!span.tags?.length) return false;
  const q = query.toLowerCase();
  for (const tag of span.tags) {
    const hints = TAG_QUERY_HINTS[tag];
    if (!hints) continue;
    if (hints.some((re) => re.test(q) || re.test(query))) return true;
  }
  return false;
}

function spansByTags(spans: SpanRecord[], tags: Set<string>): SpanRecord[] {
  return spans.filter((s) => s.tags?.some((t) => tags.has(t)));
}

/**
 * G4a rule planner: select spans to KEEP. Returns null when composition would
 * be identical to returning the full value unchanged (no prefix, all spans kept
 * with no focus narrowing).
 */
export function planComposeG4a(
  query: string,
  chunk: ChunkRecord,
  ctx: ComposeContext = {},
): ComposePlan | null {
  const spans = chunk.spans;
  if (!spans?.length) return null;

  let kept: SpanRecord[] = spans;

  // Rule 1 — polarity: false presupposition on deny chunk → correction spans only
  if (ctx.prefix === "negate-correct" && chunk.stance === "deny") {
    const correction = spansByTags(spans, CORRECTION_TAGS);
    if (correction.length) kept = correction;
  }

  // Rule 1b — dual-index retrieval pointed at a span
  if (ctx.focusSpanId) {
    const focus = spans.find((s) => s.id === ctx.focusSpanId);
    if (focus) {
      const summary = spans.filter((s) => s.tags?.includes("summary"));
      kept = [...new Set([focus, ...summary])].sort(
        (a, b) =>
          spans.findIndex((s) => s.id === a.id) -
          spans.findIndex((s) => s.id === b.id),
      );
    }
  }

  // Rule 2 — focus: query mentions a tagged topic → keep matching spans (+ summary)
  const focused = spans.filter((s) => spanMatchesQuery(s, query));
  if (focused.length > 0 && focused.length < spans.length) {
    const summary = spans.filter((s) => s.tags?.includes("summary"));
    kept = [...new Set([...focused, ...summary])].sort(
      (a, b) =>
        spans.findIndex((s) => s.id === a.id) -
        spans.findIndex((s) => s.id === b.id),
    );
  }

  // Rule 3 — partial prior-art: if query matches item tags but not ack filler
  const itemSpans = kept.filter((s) => s.tags?.includes("prior-art-item"));
  if (itemSpans.length > 0 && itemSpans.length < kept.length) {
    const closing = spans.filter((s) => s.tags?.includes("summary"));
    kept = [...itemSpans, ...closing.filter((c) => !itemSpans.includes(c))].sort(
      (a, b) =>
        spans.findIndex((s) => s.id === a.id) -
        spans.findIndex((s) => s.id === b.id),
    );
  }

  const keptRefs = kept.map((s) => ({ chunkId: chunk.id, spanId: s.id }));

  const allKept = kept.length === spans.length;
  if (allKept && !ctx.prefix) return null;

  return {
    prefix: ctx.prefix,
    kept: keptRefs,
  };
}

export function resolveKeptSpans(
  plan: ComposePlan,
  chunk: ChunkRecord,
): SpanRecord[] {
  const byId = new Map(chunk.spans?.map((s) => [s.id, s]) ?? []);
  return plan.kept
    .map((ref) => byId.get(ref.spanId))
    .filter((s): s is SpanRecord => s != null);
}

export function renderCompose(
  plan: ComposePlan,
  chunk: ChunkRecord,
  lang: Lang,
  openers: {
    negation: Record<Lang, string>;
    affirm: Record<Lang, string>;
  },
): string {
  const parts = resolveKeptSpans(plan, chunk);
  let body = joinSpanTexts(parts, lang);

  if (plan.prefix === "negate-correct") {
    body = openers.negation[lang] + body;
  } else if (plan.prefix === "affirm-confirm") {
    body = openers.affirm[lang] + body;
  }

  return body;
}

/** True when the composed body differs from the chunk's full value (or has prefix). */
export function composeChangesReply(
  plan: ComposePlan,
  chunk: ChunkRecord,
  lang: Lang,
  openers: {
    negation: Record<Lang, string>;
    affirm: Record<Lang, string>;
  },
): boolean {
  const rendered = renderCompose(plan, chunk, lang, openers);
  if (plan.prefix) return true;
  return rendered !== chunk.value;
}
