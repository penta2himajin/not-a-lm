import type { Lang } from "./types";

/** Conjunction split pattern (ja: no bare や — avoids どうやって). */
function conjunctionSep(lang: Lang): RegExp {
  return lang === "en"
    ? /\s+and\s+|,/i
    : /[、，]|と(?!は|いう|して|でも|なり)|および|また|和|与|以及|还有/;
}

/** Trim trailing request phrases/particles so an extracted segment reads as a topic. */
export function cleanSegment(seg: string, lang: Lang): string {
  let s = seg.trim();
  if (lang === "ja") {
    s = s
      .replace(/(を)?(教えて|おしえて)$/u, "")
      .replace(/について$/u, "")
      .replace(/[はをのとや、。．？！\s]+$/u, "");
  } else if (lang === "zh") {
    s = s.replace(/(是什么|呢|吗)?[？。！，、\s]*$/u, "");
  } else {
    s = s
      .replace(/^(tell me about|what about|and)\s+/i, "")
      .replace(/[?.!\s]+$/u, "");
  }
  return s.trim();
}

export function normalizeSegments(raw: string[], lang: Lang): string[] {
  return [
    ...new Set(
      raw.map((s) => cleanSegment(s, lang)).filter((s) => s.length >= 2),
    ),
  ];
}

/** Split on explicit parallel conjunctions (legacy segmentQuery). */
export function segmentByConjunction(text: string, lang: Lang): string[] {
  return text
    .split(conjunctionSep(lang))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Layer A: split on sentence / question boundaries before conjunction heuristics. */
export function segmentBySentenceBoundary(text: string): string[] {
  return text
    .split(/(?<=[？?。！])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function partitionKey(segs: string[]): string {
  return segs.join("\x1f");
}

/**
 * Layer B candidate generators → Layer C picks argmax CE bipartite score in engine.
 * Order: whole, conjunction, sentence, sentence×conjunction flatten.
 */
export function segmentCandidates(query: string, lang: Lang): string[][] {
  const text = query.trim();
  if (!text) return [];

  const seen = new Set<string>();
  const out: string[][] = [];

  const push = (raw: string[]) => {
    const segs = normalizeSegments(raw, lang);
    if (segs.length === 0) return;
    const key = partitionKey(segs);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(segs);
  };

  push([text]);
  push(segmentByConjunction(text, lang));

  const sentences = segmentBySentenceBoundary(text);
  if (sentences.length >= 2) {
    push(sentences);
    const flat: string[] = [];
    for (const sent of sentences) {
      flat.push(...segmentByConjunction(sent, lang));
    }
    push(flat);
  }

  return out;
}

/** Sync preview for trace before CE rescoring (sentence > conjunction). */
export function previewCompoundSegments(query: string, lang: Lang): string[] {
  const text = query.trim();
  if (!text) return [];

  const sentences = segmentBySentenceBoundary(text);
  if (sentences.length >= 2) {
    const sentNorm = normalizeSegments(sentences, lang);
    if (sentNorm.length >= 2) return sentNorm;
  }

  const conjNorm = normalizeSegments(segmentByConjunction(text, lang), lang);
  if (conjNorm.length >= 2) return conjNorm;

  const whole = normalizeSegments([text], lang);
  return whole;
}
