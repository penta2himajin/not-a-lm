/**
 * G7a — corpus authoring helpers (copy-only data; no reply generation).
 * Used by CLI / build to derive key bags and sentence spans from minimal input.
 */

import type { Lang, SpanRecord } from "./types.ts";

export type AuthorSpan = {
  id: string;
  text: string;
  tags?: string[];
  nliHypothesis?: string;
};

export type AuthorSurface = {
  /** Optional: auto-derived from nat+value when omitted */
  key?: string;
  nat: string;
  value: string;
  /** Optional: auto-split from value when omitted */
  spans?: AuthorSpan[];
  assertion?: string | string[];
};

export type AuthorClaim = {
  claim: string;
  speaker: "user" | "bot";
  tags?: string[];
  stance?: "affirm" | "deny";
  /** At least one language required; missing langs are not indexed */
  ja?: AuthorSurface;
  en?: AuthorSurface;
  zh?: AuthorSurface;
};

const JA_PARTICLES = /[をはがにでのとやもへからよりへと]/g;

/** Derive a keyword-bag gate key from nat (+ value hints). */
export function deriveKey(nat: string, value: string, lang: Lang): string {
  const base = `${nat} ${value}`.normalize("NFKC");
  let text = base.replace(/[？！。．、，,.!?;:「」『』【】（）()"'`]/g, " ");
  if (lang === "ja") text = text.replace(JA_PARTICLES, " ");
  if (lang === "zh") text = text.replace(/[的了呢吗吧着过]/g, " ");

  const tokens: string[] = [];
  if (lang === "en") {
    for (const t of text.toLowerCase().split(/\s+/)) {
      if (t.length >= 2) tokens.push(t);
    }
  } else {
    // CJK: split on whitespace first; leftover long runs → keep as chunks of 2–4 chars
    for (const part of text.split(/\s+/).filter(Boolean)) {
      if (/^[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+$/.test(part) && part.length > 4) {
        for (let i = 0; i < part.length; i += 2) {
          const slice = part.slice(i, i + 2);
          if (slice.length >= 2) tokens.push(slice);
        }
      } else if (part.length >= 1) {
        tokens.push(part.toLowerCase());
      }
    }
  }

  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
    if (uniq.length >= 24) break;
  }
  return uniq.join(" ") || nat.slice(0, 32);
}

/**
 * Split value into sentence-ish spans. Must satisfy joinSpanTexts semantics:
 * en joins with single spaces; ja/zh concatenate.
 * Falls back to one full-value span when split cannot reconstruct value.
 */
export function autoSpans(value: string, lang: Lang): AuthorSpan[] {
  const v = value;
  if (!v.trim()) return [];

  let parts: string[] = [];
  if (lang === "en") {
    parts = v
      .split(/(?<=[.!?])\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
  } else {
    // Keep delimiter on the left; split after 。！？
    parts = [];
    let buf = "";
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      buf += ch;
      if ("。！？".includes(ch)) {
        parts.push(buf);
        buf = "";
      }
    }
    if (buf) parts.push(buf);
  }

  if (parts.length === 0) parts = [v];

  const joined = lang === "en" ? parts.join(" ") : parts.join("");
  if (joined !== v) {
    return [{ id: "full", text: v, tags: ["auto"] }];
  }

  return parts.map((text, i) => ({
    id: parts.length === 1 ? "full" : `s${i + 1}`,
    text,
    tags: ["auto"],
  }));
}

export function joinAuthorSpans(spans: AuthorSpan[], lang: Lang): string {
  if (!spans.length) return "";
  if (lang === "en") return spans.map((s) => s.text).join(" ");
  return spans.map((s) => s.text).join("");
}

/** Fill missing key/spans on a surface (does not invent value/nat). */
export function finalizeSurface(
  surface: AuthorSurface,
  lang: Lang,
): AuthorSurface & { key: string; spans: AuthorSpan[] } {
  const key = surface.key?.trim() || deriveKey(surface.nat, surface.value, lang);
  let spans = surface.spans;
  if (!spans?.length) spans = autoSpans(surface.value, lang);
  const joined = joinAuthorSpans(spans, lang);
  if (joined !== surface.value) {
    spans = [{ id: "full", text: surface.value, tags: ["auto"] }];
  }
  return { ...surface, key, spans };
}

export function langsOfClaim(claim: AuthorClaim): Lang[] {
  const out: Lang[] = [];
  if (claim.ja) out.push("ja");
  if (claim.en) out.push("en");
  if (claim.zh) out.push("zh");
  return out;
}

export function finalizeClaim(claim: AuthorClaim): AuthorClaim {
  const out: AuthorClaim = {
    claim: claim.claim,
    speaker: claim.speaker,
    tags: claim.tags?.length ? claim.tags : ["untagged"],
    stance: claim.stance,
  };
  if (claim.ja) out.ja = finalizeSurface(claim.ja, "ja");
  if (claim.en) out.en = finalizeSurface(claim.en, "en");
  if (claim.zh) out.zh = finalizeSurface(claim.zh, "zh");
  return out;
}
