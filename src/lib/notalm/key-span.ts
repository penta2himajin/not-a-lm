/**
 * Automatic key-span extraction from chunk values (retrieval hooks only).
 *
 * Splits value into sentence-like segments, scores character n-grams with
 * corpus TF-IDF keyness, merges high-scoring n-grams into contiguous
 * substrings of `value`. Output is deterministic and audit-friendly.
 */

import type { ChunkRecord, Lang } from "./types.ts";

export type AutoKeySpan = {
  id: string;
  text: string;
  start: number;
  end: number;
  /** Corpus keyness score (for debugging / eval) */
  score: number;
};

const CHAR_N = 3;
const MIN_SPAN_CHARS = 3;
const MAX_SPAN_CHARS = 64;
/** Keep n-grams scoring at least this fraction of the segment's top n-gram */
const SCORE_RATIO = 0.55;
const MAX_SPANS_PER_SEGMENT = 4;

/** Split on sentence-ending punctuation (multilingual). */
export function splitSentences(value: string): { text: string; start: number }[] {
  const parts: { text: string; start: number }[] = [];
  let start = 0;
  const re = /[。！？.!?]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const end = m.index + m[0].length;
    const text = value.slice(start, end).trim();
    if (text) parts.push({ text, start });
    start = end;
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push({ text: tail, start });
  if (parts.length === 0 && value.trim()) parts.push({ text: value.trim(), start: 0 });
  return parts;
}

function charNgrams(text: string, n: number): { gram: string; start: number }[] {
  const out: { gram: string; start: number }[] = [];
  const compact = text.replace(/\s+/g, " ");
  for (let i = 0; i <= compact.length - n; i++) {
    out.push({ gram: compact.slice(i, i + n), start: i });
  }
  return out;
}

/** Document frequency of char n-grams across all bot chunk values. */
export function buildCorpusNgramDf(chunks: ChunkRecord[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const chunk of chunks) {
    if (chunk.speaker !== "bot") continue;
    const seen = new Set<string>();
    for (const seg of splitSentences(chunk.value)) {
      for (const { gram } of charNgrams(seg.text, CHAR_N)) {
        seen.add(gram);
      }
    }
    for (const g of seen) df.set(g, (df.get(g) ?? 0) + 1);
  }
  return df;
}

function overlapsAuthor(
  start: number,
  end: number,
  authorTexts: string[],
  value: string,
): boolean {
  for (const at of authorTexts) {
    const idx = value.indexOf(at);
    if (idx < 0) continue;
    const a0 = idx;
    const a1 = idx + at.length;
    const overlap = Math.max(0, Math.min(end, a1) - Math.max(start, a0));
    if (overlap / Math.max(1, end - start) >= 0.7) return true;
  }
  return false;
}

function mergeIntervals(
  intervals: { start: number; end: number; score: number }[],
): { start: number; end: number; score: number }[] {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start || b.score - a.score);
  const merged: { start: number; end: number; score: number }[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end + 1) {
      last.end = Math.max(last.end, iv.end);
      last.score = Math.max(last.score, iv.score);
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

/**
 * Extract auto key-spans from one chunk value. Skips intervals that largely
 * overlap author span texts (author spans are indexed separately).
 */
export function extractAutoKeySpans(
  chunk: ChunkRecord,
  corpusDf: Map<string, number>,
  totalSegments: number,
): AutoKeySpan[] {
  if (chunk.speaker !== "bot" || !chunk.value.trim()) return [];

  const authorTexts = chunk.spans?.map((s) => s.text) ?? [];
  const segments = splitSentences(chunk.value);
  const intervals: { start: number; end: number; score: number }[] = [];

  for (const seg of segments) {
    const grams = charNgrams(seg.text, CHAR_N);
    const tf = new Map<string, number>();
    for (const { gram } of grams) tf.set(gram, (tf.get(gram) ?? 0) + 1);

    const scored: { gram: string; start: number; score: number }[] = [];
    for (const { gram, start: gs } of grams) {
      const df = corpusDf.get(gram) ?? 1;
      const idf = Math.log((totalSegments + 1) / df);
      const score = (tf.get(gram) ?? 1) * idf;
      scored.push({ gram, start: gs, score });
    }
    if (!scored.length) continue;

    scored.sort((a, b) => b.score - a.score);
    const top = scored[0].score * SCORE_RATIO;
    const hot = scored.filter((s) => s.score >= top);

    const byStart = new Map<number, { end: number; score: number }>();
    for (const h of hot.slice(0, 20)) {
      const absStart = seg.start + h.start;
      const absEnd = absStart + CHAR_N;
      const prev = byStart.get(absStart);
      if (!prev || h.score > prev.score) byStart.set(absStart, { end: absEnd, score: h.score });
    }

    const localIntervals = mergeIntervals(
      [...byStart.entries()].map(([start, { end, score }]) => ({ start, end, score })),
    );

    let added = 0;
    for (const iv of localIntervals) {
      if (added >= MAX_SPANS_PER_SEGMENT) break;
      let { start, end } = iv;
      while (end - start < MIN_SPAN_CHARS && end < chunk.value.length) end++;
      if (end - start > MAX_SPAN_CHARS) end = start + MAX_SPAN_CHARS;
      const text = chunk.value.slice(start, end);
      if (text.length < MIN_SPAN_CHARS) continue;
      if (overlapsAuthor(start, end, authorTexts, chunk.value)) continue;
      intervals.push({ start, end, score: iv.score });
      added++;
    }
  }

  const merged = mergeIntervals(intervals);
  return merged.map((iv, i) => ({
    id: `auto-${i}`,
    text: chunk.value.slice(iv.start, iv.end),
    start: iv.start,
    end: iv.end,
    score: iv.score,
  }));
}

/** Build auto key-spans for all bot chunks. */
export function buildAllAutoKeySpans(chunks: ChunkRecord[]): Map<string, AutoKeySpan[]> {
  const bot = chunks.filter((c) => c.speaker === "bot");
  const df = buildCorpusNgramDf(bot);
  let totalSegments = 0;
  for (const c of bot) totalSegments += splitSentences(c.value).length;

  const out = new Map<string, AutoKeySpan[]>();
  for (const chunk of bot) {
    out.set(chunk.id, extractAutoKeySpans(chunk, df, totalSegments));
  }
  return out;
}
