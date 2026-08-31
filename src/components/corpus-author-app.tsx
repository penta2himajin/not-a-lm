"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, FilePlus2, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  finalizeClaim,
  finalizeSurface,
  langsOfClaim,
  type AuthorClaim,
  type AuthorSurface,
} from "@/lib/notalm/corpus-author";
import type { Lang } from "@/lib/notalm/types";

const LANGS: Lang[] = ["ja", "en", "zh"];
const LANG_LABEL: Record<Lang, string> = {
  ja: "日本語",
  en: "English",
  zh: "中文",
};

type SurfaceForm = { nat: string; value: string; enabled: boolean };

function emptySurface(): SurfaceForm {
  return { nat: "", value: "", enabled: false };
}

function buildClaim(
  claimId: string,
  speaker: "bot" | "user",
  tags: string,
  stance: "" | "affirm" | "deny",
  surfaces: Record<Lang, SurfaceForm>,
): AuthorClaim {
  const out: AuthorClaim = {
    claim: claimId.trim(),
    speaker,
    tags: tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  };
  if (stance) out.stance = stance;
  for (const lang of LANGS) {
    const s = surfaces[lang];
    if (!s.enabled) continue;
    if (!s.nat.trim() && !s.value.trim()) continue;
    out[lang] = { nat: s.nat, value: s.value };
  }
  return out;
}

export function CorpusAuthorApp() {
  const [claimId, setClaimId] = useState("demo-new");
  const [speaker, setSpeaker] = useState<"bot" | "user">("bot");
  const [tags, setTags] = useState("demo");
  const [stance, setStance] = useState<"" | "affirm" | "deny">("");
  const [surfaces, setSurfaces] = useState<Record<Lang, SurfaceForm>>({
    ja: { nat: "", value: "", enabled: true },
    en: emptySurface(),
    zh: emptySurface(),
  });
  const [claimList, setClaimList] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedYaml, setSavedYaml] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    const res = await fetch("/api/corpus");
    const data = (await res.json()) as { claims?: string[] };
    setClaimList(data.claims ?? []);
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const draft = useMemo(
    () => buildClaim(claimId, speaker, tags, stance, surfaces),
    [claimId, speaker, tags, stance, surfaces],
  );

  const preview = useMemo(() => {
    try {
      if (!draft.claim || langsOfClaim(draft).length === 0) return null;
      return finalizeClaim(draft);
    } catch {
      return null;
    }
  }, [draft]);

  const yamlPreview = useMemo(() => {
    if (!preview) return "# nat + value を1言語以上入れると YAML がここに出ます";
    // Lightweight YAML-ish dump for display (server uses yaml package on save)
    const lines: string[] = [];
    lines.push(`claim: ${preview.claim}`);
    lines.push(`speaker: ${preview.speaker}`);
    if (preview.tags?.length) {
      lines.push("tags:");
      for (const t of preview.tags) lines.push(`  - ${t}`);
    }
    if (preview.stance) lines.push(`stance: ${preview.stance}`);
    for (const lang of LANGS) {
      const s = preview[lang];
      if (!s) continue;
      const fin = finalizeSurface(s as AuthorSurface, lang);
      lines.push(`${lang}:`);
      lines.push(`  nat: ${JSON.stringify(fin.nat)}`);
      lines.push(`  value: ${JSON.stringify(fin.value)}`);
      lines.push(`  key: ${JSON.stringify(fin.key)}`);
      lines.push(`  spans:`);
      for (const sp of fin.spans) {
        lines.push(`    - id: ${sp.id}`);
        lines.push(`      text: ${JSON.stringify(sp.text)}`);
        lines.push(`      tags:`);
        for (const t of sp.tags ?? ["auto"]) lines.push(`        - ${t}`);
      }
    }
    return lines.join("\n");
  }, [preview]);

  function patchSurface(lang: Lang, patch: Partial<SurfaceForm>) {
    setSurfaces((prev) => ({
      ...prev,
      [lang]: { ...prev[lang], ...patch },
    }));
  }

  async function onSave(force = false) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setSavedYaml(null);
    try {
      const res = await fetch("/api/corpus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", claim: draft, force }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          setError(`${data.error} — 「上書き保存」で強制できます`);
        } else {
          setError(typeof data.error === "string" ? data.error : "保存に失敗");
        }
        return;
      }
      setNotice(`保存しました: corpus/claims/${draft.claim}.yml（${data.claimCount} claims）`);
      setSavedYaml(typeof data.yaml === "string" ? data.yaml : null);
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗");
    } finally {
      setBusy(false);
    }
  }

  async function loadExisting(id: string) {
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/corpus?claim=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "読込失敗");
      return;
    }
    const c = data.claim as AuthorClaim;
    setClaimId(c.claim);
    setSpeaker(c.speaker);
    setTags((c.tags ?? []).join(", "));
    setStance(c.stance ?? "");
    setSurfaces({
      ja: c.ja
        ? { nat: c.ja.nat, value: c.ja.value, enabled: true }
        : emptySurface(),
      en: c.en
        ? { nat: c.en.nat, value: c.en.value, enabled: true }
        : emptySurface(),
      zh: c.zh
        ? { nat: c.zh.nat, value: c.zh.value, enabled: true }
        : emptySurface(),
    });
    setNotice(`読込: ${id}`);
  }

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-mesh" aria-hidden />
      <div
        className="pointer-events-none absolute -top-24 right-10 h-72 w-72 rounded-full bg-[radial-gradient(circle,var(--nalm-glow)_0%,transparent_70%)] opacity-60 blur-2xl"
        aria-hidden
      />

      <div className="relative mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 md:px-6 md:py-8">
        <header className="mb-6 animate-in-fade">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--nalm-ink-mute)] uppercase tracking-[0.18em] hover:text-[var(--nalm-ink)]"
            >
              <ArrowLeft className="size-3.5" />
              chat
            </Link>
            <Badge variant="outline" className="font-mono text-[11px]">
              G7b author
            </Badge>
            <Badge variant="secondary" className="font-mono text-[11px]">
              claims: {claimList.length || "—"}
            </Badge>
          </div>
          <h1 className="mt-3 font-[family-name:var(--font-display)] text-4xl leading-none tracking-tight text-[var(--nalm-ink)] md:text-5xl">
            Corpus
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--nalm-ink-soft)]">
            最小入力は claim / speaker / 1言語の nat+value。key と spans
            は自動。欠けた言語は index されない。保存で YAML を書いて
            corpus:build する。
          </p>
        </header>

        <div className="grid flex-1 gap-4 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="space-y-4 rounded-2xl border border-[var(--nalm-line)] bg-[var(--nalm-panel)]/85 p-4 backdrop-blur-md md:p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 text-sm">
                <span className="font-mono text-[11px] text-[var(--nalm-ink-mute)]">
                  claim
                </span>
                <Input
                  value={claimId}
                  onChange={(e) => setClaimId(e.target.value)}
                  placeholder="kebab-id"
                  className="font-mono"
                />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-mono text-[11px] text-[var(--nalm-ink-mute)]">
                  speaker
                </span>
                <select
                  value={speaker}
                  onChange={(e) => setSpeaker(e.target.value as "bot" | "user")}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  <option value="bot">bot</option>
                  <option value="user">user</option>
                </select>
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-mono text-[11px] text-[var(--nalm-ink-mute)]">
                  tags (comma)
                </span>
                <Input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="weather, smalltalk"
                />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-mono text-[11px] text-[var(--nalm-ink-mute)]">
                  stance
                </span>
                <select
                  value={stance}
                  onChange={(e) =>
                    setStance(e.target.value as "" | "affirm" | "deny")
                  }
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  <option value="">(none)</option>
                  <option value="affirm">affirm</option>
                  <option value="deny">deny</option>
                </select>
              </label>
            </div>

            {LANGS.map((lang) => {
              const s = surfaces[lang];
              return (
                <div
                  key={lang}
                  className={cn(
                    "space-y-2 border-t border-[var(--nalm-line)] pt-4",
                    !s.enabled && "opacity-55",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-sm text-[var(--nalm-ink)]">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={(e) =>
                          patchSurface(lang, { enabled: e.target.checked })
                        }
                      />
                      <span className="font-medium">{LANG_LABEL[lang]}</span>
                      <span className="font-mono text-[11px] text-[var(--nalm-ink-mute)]">
                        {lang}
                      </span>
                    </label>
                    {s.enabled && s.value.trim() && (
                      <span className="font-mono text-[10px] text-[var(--nalm-ink-mute)]">
                        spans ≈{" "}
                        {
                          finalizeSurface(
                            { nat: s.nat, value: s.value },
                            lang,
                          ).spans.length
                        }
                      </span>
                    )}
                  </div>
                  {s.enabled && (
                    <>
                      <Textarea
                        value={s.nat}
                        onChange={(e) =>
                          patchSurface(lang, { nat: e.target.value })
                        }
                        placeholder={`${lang} nat（質問・きっかけ）`}
                        rows={2}
                        className="min-h-[3rem] resize-y"
                      />
                      <Textarea
                        value={s.value}
                        onChange={(e) =>
                          patchSurface(lang, { value: e.target.value })
                        }
                        placeholder={`${lang} value（返答本文）`}
                        rows={3}
                        className="min-h-[4.5rem] resize-y"
                      />
                      {s.nat.trim() && s.value.trim() && (
                        <p className="font-mono text-[10px] leading-relaxed text-[var(--nalm-ink-mute)]">
                          key:{" "}
                          {
                            finalizeSurface(
                              { nat: s.nat, value: s.value },
                              lang,
                            ).key
                          }
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
            })}

            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                onClick={() => void onSave(false)}
                disabled={busy || langsOfClaim(draft).length === 0}
                className="gap-1.5 bg-[var(--nalm-accent)] text-[var(--nalm-ink)] hover:bg-[var(--nalm-accent-hot)]"
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                保存 + build
              </Button>
              <Button
                variant="outline"
                onClick={() => void onSave(true)}
                disabled={busy || langsOfClaim(draft).length === 0}
                className="gap-1.5"
              >
                <FilePlus2 className="size-3.5" />
                上書き保存
              </Button>
            </div>

            {error && (
              <p className="text-sm text-red-700" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="text-sm text-[var(--nalm-ink-soft)]" role="status">
                {notice}
              </p>
            )}
          </section>

          <aside className="flex min-h-[40vh] flex-col gap-3">
            <div className="flex-1 overflow-hidden rounded-2xl border border-[var(--nalm-line)] bg-[var(--nalm-ink)]/95 p-4 text-[var(--nalm-panel)] shadow-[0_20px_60px_-40px_rgba(20,40,30,0.55)]">
              <p className="mb-2 font-mono text-[11px] tracking-[0.16em] text-[var(--nalm-accent)] uppercase">
                preview · auto key/spans
              </p>
              <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[#d7e8db]">
                {savedYaml ?? yamlPreview}
              </pre>
            </div>

            <div className="rounded-2xl border border-[var(--nalm-line)] bg-[var(--nalm-panel)]/80 p-3 backdrop-blur-md">
              <p className="mb-2 font-mono text-[11px] text-[var(--nalm-ink-mute)]">
                existing claims
              </p>
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                {claimList.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => void loadExisting(id)}
                    className="rounded-md border border-[var(--nalm-line)] bg-white/40 px-2 py-1 font-mono text-[10px] text-[var(--nalm-ink)] hover:border-[var(--nalm-accent)] hover:bg-[var(--nalm-accent-soft)]"
                  >
                    {id}
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
