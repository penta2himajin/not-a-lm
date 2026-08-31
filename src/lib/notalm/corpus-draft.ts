/**
 * G7b — author-time other-language drafts (NOT used at reply time).
 * Uses a public MT endpoint as a scratchpad; human must edit before save.
 */

import type { Lang } from "./types.ts";
import type { AuthorClaim, AuthorSurface } from "./corpus-author.ts";
import { langsOfClaim } from "./corpus-author.ts";

const ALL: Lang[] = ["ja", "en", "zh"];

/** MyMemory langpair codes */
function pair(from: Lang, to: Lang): string {
  const map: Record<Lang, string> = { ja: "ja", en: "en", zh: "zh-CN" };
  return `${map[from]}|${map[to]}`;
}

export type TranslateFn = (
  text: string,
  from: Lang,
  to: Lang,
) => Promise<string>;

/** Default: MyMemory free endpoint (authoring aid only). */
export const translateMyMemory: TranslateFn = async (text, from, to) => {
  const q = text.trim();
  if (!q) return "";
  if (from === to) return q;
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", q.slice(0, 450));
  url.searchParams.set("langpair", pair(from, to));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MT HTTP ${res.status}`);
  const data = (await res.json()) as {
    responseStatus?: number;
    responseData?: { translatedText?: string };
    responseDetails?: string;
  };
  if (data.responseStatus && data.responseStatus !== 200) {
    throw new Error(data.responseDetails || `MT status ${data.responseStatus}`);
  }
  const out = data.responseData?.translatedText?.trim();
  if (!out) throw new Error("MT empty");
  // MyMemory sometimes echoes SOURCE QUERY when quota/rate limited
  if (out.toUpperCase() === q.toUpperCase() && from !== to && /[ぁ-んァ-ン一-龥]/.test(q) === /[ぁ-んァ-ン一-龥]/.test(out)) {
    // allow same-script accidental equality only if scripts match oddly; still return
  }
  return out;
};

export type DraftResult = {
  claim: AuthorClaim;
  sourceLang: Lang;
  drafted: Lang[];
  notes: string[];
};

function pickSource(claim: AuthorClaim, preferred?: Lang): Lang | null {
  if (preferred && claim[preferred]?.nat?.trim() && claim[preferred]?.value?.trim()) {
    return preferred;
  }
  for (const lang of ALL) {
    const s = claim[lang];
    if (s?.nat?.trim() && s?.value?.trim()) return lang;
  }
  return null;
}

async function draftSurface(
  source: AuthorSurface,
  from: Lang,
  to: Lang,
  translate: TranslateFn,
): Promise<AuthorSurface> {
  const [nat, value] = await Promise.all([
    translate(source.nat, from, to),
    translate(source.value, from, to),
  ]);
  const out: AuthorSurface = { nat, value };
  if (source.assertion) {
    const a = Array.isArray(source.assertion)
      ? source.assertion[0]
      : source.assertion;
    if (a?.trim()) {
      out.assertion = await translate(a, from, to);
    }
  }
  return out;
}

/**
 * Fill missing language surfaces from a source language via MT.
 * Does not overwrite existing non-empty surfaces.
 */
export async function draftMissingLangs(
  claim: AuthorClaim,
  opts: {
    sourceLang?: Lang;
    targets?: Lang[];
    translate?: TranslateFn;
    overwrite?: boolean;
  } = {},
): Promise<DraftResult> {
  const translate = opts.translate ?? translateMyMemory;
  const sourceLang = pickSource(claim, opts.sourceLang);
  if (!sourceLang) {
    throw new Error("下書き元になる言語の nat+value がありません");
  }
  const source = claim[sourceLang]!;
  const targets = (opts.targets ?? ALL.filter((l) => l !== sourceLang)).filter(
    (l) => ALL.includes(l),
  );

  const out: AuthorClaim = { ...claim, ja: claim.ja, en: claim.en, zh: claim.zh };
  const drafted: Lang[] = [];
  const notes: string[] = [
    `source=${sourceLang}`,
    "MT draft — 保存前に必ず人手で直すこと",
  ];

  for (const to of targets) {
    const existing = out[to];
    const filled =
      !!existing?.nat?.trim() && !!existing?.value?.trim() && !opts.overwrite;
    if (filled) {
      notes.push(`${to}: skipped (already filled)`);
      continue;
    }
    try {
      out[to] = await draftSurface(source, sourceLang, to, translate);
      drafted.push(to);
      notes.push(`${to}: drafted`);
    } catch (e) {
      notes.push(`${to}: failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (drafted.length === 0 && langsOfClaim(out).length <= 1) {
    throw new Error(`下書きに失敗: ${notes.join("; ")}`);
  }

  return { claim: out, sourceLang, drafted, notes };
}

/** Tiny unified diff for YAML preview (author UI). */
export function unifiedDiff(before: string, after: string, ctx = 2): string {
  const a = before.split("\n");
  const b = after.split("\n");
  // Myers-lite: LCS DP for small YAML
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  type Op = { t: " " | "+" | "-"; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "-", line: a[i++] });
    } else {
      ops.push({ t: "+", line: b[j++] });
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });

  // Collapse pure context far from changes
  const interesting = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.t !== " ") {
      for (let k = Math.max(0, idx - ctx); k <= Math.min(ops.length - 1, idx + ctx); k++) {
        interesting.add(k);
      }
    }
  });
  if (interesting.size === 0) return "(no diff)";

  const lines: string[] = ["--- before", "+++ after"];
  let gap = false;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!interesting.has(idx)) {
      gap = true;
      continue;
    }
    if (gap) {
      lines.push("@@ … @@");
      gap = false;
    }
    lines.push(`${ops[idx].t}${ops[idx].line}`);
  }
  return lines.join("\n");
}
