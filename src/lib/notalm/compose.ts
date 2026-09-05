/**
 * G4 — span-level grounded composition (copy-only, closed glue).
 *
 * Author-defined spans on a chunk are the atomic units. The G4a planner
 * selects which spans to KEEP (order preserved); renderCompose joins them with
 * closed-set glue. No token generation — every output substring is a copy of a
 * corpus span (plus optional closed prefix from G2).
 */

import type { ChunkRecord, ComposePlan, Lang, SpanRecord } from "./types";
import { isNliReady, nliClassify, normalizeForNli } from "./nli.ts";
import { cosine, embedMany } from "./embed.ts";
import { indexTextForSpan } from "./span-index.ts";

/** Min span–query cosine for G4b embedding focus */
export const G4B_MIN_COS = 0.32;
/** Keep spans within this margin of the top G4b score */
export const G4B_MARGIN = 0.06;

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
  identity: [/誰/, /who are you/i, /你是谁/, /LLM/i, /言語モデル/, /语言模型/],
  help: [/使い方/, /ヘルプ/, /how to use/i, /怎么用/, /help/i, /何ができる/],
  kv: [/KV/, /kv cache/i, /キーバリュー/, /键值/, /attention/i, /キャッシュ/],
  greeting: [/こんにちは/, /hello/i, /你好/, /はじめまして/],
};

/** full: narrow only on polarity / explicit focus (tags, dual-index). partial: also G4b/G4c. */
export type ComposeDefaultMode = "full" | "partial";

export type ComposeContext = {
  /** From G2 NLI when grounded generation detected polarity */
  prefix?: "negate-correct" | "affirm-confirm";
  /** From dual-index retrieval: prefer this author span in compose */
  focusSpanId?: string;
  /** From dual-index retrieval: auto key-span substring (copy-only) */
  focusKeySpanText?: string;
  /**
   * full (default): single-chunk / fuse-primary — keep whole value unless polarity
   * or explicit focus narrows. partial: fuse-secondary — allow G4b/G4c auto focus.
   */
  defaultMode?: ComposeDefaultMode;
  /** G4b: span id → query cosine (engine/fusion precomputes) */
  spanRankings?: { spanId: string; score: number }[];
  /** G4c: span id → NLI entailment vs span.nliHypothesis */
  spanNliRankings?: { spanId: string; entail: number; label: string }[];
};

/** Min entailment for G4c per-span NLI focus / negate refine */
export const G4C_ENTAIL_MIN = 0.5;

/** Rank spans that declare nliHypothesis via NLI(premise=query, hypothesis). */
export async function rankSpansByNli(
  query: string,
  spans: SpanRecord[],
): Promise<{ spanId: string; entail: number; label: string }[]> {
  if (!isNliReady() || !spans.length || !query.trim()) return [];
  const premise = normalizeForNli(query);
  const out: { spanId: string; entail: number; label: string }[] = [];
  for (const span of spans) {
    if (!span.nliHypothesis) continue;
    const nli = await nliClassify(premise, span.nliHypothesis);
    out.push({ spanId: span.id, entail: nli.entail, label: nli.label });
  }
  return out.sort((a, b) => b.entail - a.entail);
}

/** Rank author spans by dense embedding vs query (index-time tag prefixes). */
export async function rankSpansForCompose(
  query: string,
  spans: SpanRecord[],
): Promise<{ spanId: string; score: number }[]> {
  if (!spans.length || !query.trim()) return [];
  const indexed = spans.map((s) => indexTextForSpan(s));
  const vecs = await embedMany([query, ...indexed], "dense");
  const qv = vecs[0];
  return spans
    .map((s, i) => ({
      spanId: s.id,
      score: cosine(qv, vecs[i + 1]),
    }))
    .sort((a, b) => b.score - a.score);
}

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

  const defaultMode = ctx.defaultMode ?? "full";
  const allowAutoNarrow = defaultMode === "partial";

  let kept: SpanRecord[] = spans;

  // Rule 1 — polarity: false presupposition on deny chunk → correction spans only
  if (ctx.prefix === "negate-correct" && chunk.stance === "deny") {
    const correction = spansByTags(spans, CORRECTION_TAGS);
    if (correction.length) kept = correction;
  }

  // Rule 1d — G4c: per-span NLI refines correction set (spans with nliHypothesis)
  if (
    ctx.prefix === "negate-correct" &&
    chunk.stance === "deny" &&
    ctx.spanNliRankings?.length
  ) {
    const entailed = new Set(
      ctx.spanNliRankings
        .filter((r) => r.entail >= G4C_ENTAIL_MIN)
        .map((r) => r.spanId),
    );
    const refined = kept.filter((s) => entailed.has(s.id));
    if (refined.length > 0) kept = refined;
  }

  // Rule 1b — dual-index retrieval pointed at an author span
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

  // Rule 1c — auto key-span hit: map to overlapping author span or keySpanText
  let keySpanOnly = false;
  if (ctx.focusKeySpanText && chunk.value.includes(ctx.focusKeySpanText)) {
    const overlap = spans.find(
      (s) =>
        s.text.includes(ctx.focusKeySpanText!) ||
        ctx.focusKeySpanText!.includes(s.text),
    );
    if (overlap) {
      const summary = spans.filter((s) => s.tags?.includes("summary"));
      kept = [...new Set([overlap, ...summary])].sort(
        (a, b) =>
          spans.findIndex((s) => s.id === a.id) -
          spans.findIndex((s) => s.id === b.id),
      );
    } else {
      kept = spans.filter((s) => s.tags?.includes("summary"));
      keySpanOnly = true;
    }
  }

  // Rule 2 — focus: query mentions a tagged topic → keep matching spans (+ summary)
  const focused = spans.filter((s) => spanMatchesQuery(s, query));
  if (
    focused.length > 0 &&
    focused.length < spans.length &&
    ctx.prefix !== "negate-correct"
  ) {
    const summary = spans.filter((s) => s.tags?.includes("summary"));
    kept = [...new Set([...focused, ...summary])].sort(
      (a, b) =>
        spans.findIndex((s) => s.id === a.id) -
        spans.findIndex((s) => s.id === b.id),
    );
  }

  // Rule 2b — G4b: embedding focus when tags did not narrow to a proper subset
  if (
    allowAutoNarrow &&
    ctx.spanRankings?.length &&
    kept.length === spans.length &&
    ctx.prefix !== "negate-correct" &&
    !ctx.focusSpanId &&
    !ctx.focusKeySpanText
  ) {
    const byId = new Map(spans.map((s) => [s.id, s]));
    const ranked = ctx.spanRankings
      .map((r) => ({ span: byId.get(r.spanId), score: r.score }))
      .filter(
        (r): r is { span: SpanRecord; score: number } =>
          r.span != null &&
          r.score >= G4B_MIN_COS &&
          !r.span.tags?.includes("filler") &&
          !r.span.tags?.includes("ack"),
      );
    if (ranked.length >= 1) {
      const top = ranked[0].score;
      const winners = ranked
        .filter((r) => r.score >= top - G4B_MARGIN)
        .map((r) => r.span);
      if (winners.length > 0 && winners.length < spans.length) {
        const summary = spans.filter((s) => s.tags?.includes("summary"));
        kept = [...new Set([...winners, ...summary])].sort(
          (a, b) =>
            spans.findIndex((s) => s.id === a.id) -
            spans.findIndex((s) => s.id === b.id),
        );
      }
    }
  }

  // Rule 2c — G4c: NLI focus when tags + G4b did not narrow (spans with nliHypothesis)
  if (
    allowAutoNarrow &&
    ctx.spanNliRankings?.length &&
    kept.length === spans.length &&
    ctx.prefix !== "negate-correct" &&
    !ctx.focusSpanId &&
    !ctx.focusKeySpanText
  ) {
    const byId = new Map(spans.map((s) => [s.id, s]));
    const ranked = ctx.spanNliRankings.filter(
      (r) => r.entail >= G4C_ENTAIL_MIN && byId.has(r.spanId),
    );
    if (ranked.length >= 1) {
      const top = ranked[0].entail;
      const winners = ranked
        .filter((r) => r.entail >= top - 0.08)
        .map((r) => byId.get(r.spanId)!)
        .filter((s) => !s.tags?.includes("filler") && !s.tags?.includes("ack"));
      if (winners.length > 0 && winners.length < spans.length) {
        const summary = spans.filter((s) => s.tags?.includes("summary"));
        kept = [...new Set([...winners, ...summary])].sort(
          (a, b) =>
            spans.findIndex((s) => s.id === a.id) -
            spans.findIndex((s) => s.id === b.id),
        );
      }
    }
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
  if (allKept && !ctx.prefix && !keySpanOnly) return null;

  const plan: ComposePlan = {
    prefix: ctx.prefix,
    kept: keptRefs,
  };

  if (keySpanOnly && ctx.focusKeySpanText) {
    plan.keySpanText = ctx.focusKeySpanText;
  }

  return plan;
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
  let body = plan.keySpanText
    ? plan.keySpanText + joinSpanTexts(parts, lang)
    : joinSpanTexts(parts, lang);

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
  if (plan.prefix || plan.keySpanText) return true;
  return rendered !== chunk.value;
}

export type ComposePartResult = {
  text: string;
  plan: ComposePlan | null;
};

/**
 * G4 on one G3 fusion segment: plan from the segment query, render copy-only body.
 * Returns full `value` when the chunk has no spans or compose would be unchanged.
 */
export async function composePartBody(
  segmentQuery: string,
  chunk: ChunkRecord,
  lang: Lang,
  openers: {
    negation: Record<Lang, string>;
    affirm: Record<Lang, string>;
  },
  ctx: ComposeContext = {},
): Promise<ComposePartResult> {
  if (!chunk.spans?.length) {
    return { text: chunk.value, plan: null };
  }
  const fullCtx: ComposeContext = {
    defaultMode: "partial",
    ...ctx,
  };
  if (!fullCtx.spanRankings?.length) {
    fullCtx.spanRankings = await rankSpansForCompose(
      segmentQuery,
      chunk.spans,
    );
  }
  if (!fullCtx.spanNliRankings?.length) {
    fullCtx.spanNliRankings = await rankSpansByNli(segmentQuery, chunk.spans);
  }
  const plan = planComposeG4a(segmentQuery, chunk, fullCtx);
  if (!plan || !composeChangesReply(plan, chunk, lang, openers)) {
    return { text: chunk.value, plan: null };
  }
  return {
    text: renderCompose(plan, chunk, lang, openers),
    plan,
  };
}
