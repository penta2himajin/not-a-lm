"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, FilePenLine, Link2, Loader2, RotateCcw, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { ChainPlan, ChatMessage, TraceStep } from "@/lib/notalm/types";
import { formatOperationPlan } from "@/lib/notalm/plan";
import { formatTurnGrounding } from "@/lib/notalm/grounding";
import { formatChainPlan } from "@/lib/notalm/chain-plan";

const SUGGESTIONS = [
  "お前誰？",
  "仕組み教えて",
  "Who are you?",
  "How does it work?",
  "你是谁？",
  "讲讲原理",
];

type StatusPayload = {
  modelId: string;
  progress: string;
  denseReady: boolean;
  rerankerReady?: boolean;
  rerankerLabel?: string;
  rerankerProgress?: string;
  nliReady?: boolean;
  nliLabel?: string;
  nliProgress?: string;
  chunkCount: number;
  status: {
    kind: string;
    backend?: string;
    detail?: string;
    chunkCount?: number;
  };
};

type ChatPayload = {
  message: ChatMessage;
  trace: TraceStep;
  backend: string;
  modelId: string;
  error?: string;
  plan?: ChainPlan;
  seedText?: string;
};

export function NotALMApp() {
  const [ready, setReady] = useState(false);
  const [backend, setBackend] = useState<"hash" | "dense">("hash");
  const [modelId, setModelId] = useState("…");
  const [progress, setProgress] = useState("起動中…");
  const [upgrading, setUpgrading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [traces, setTraces] = useState<TraceStep[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chunkCount, setChunkCount] = useState(0);
  const [rerankerReady, setRerankerReady] = useState(false);
  const [nliReady, setNliReady] = useState(false);
  const [chainPlan, setChainPlan] = useState<ChainPlan | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    const res = await fetch("/api/status");
    const data = (await res.json()) as StatusPayload;
    setModelId(data.modelId);
    setProgress(data.progress);
    setChunkCount(data.chunkCount);
    setRerankerReady(!!data.rerankerReady);
    setNliReady(!!data.nliReady);
    if (data.status.kind === "ready") {
      setReady(true);
      const b = (data.status.backend as "hash" | "dense") || "hash";
      setBackend(b);
      if (b === "dense") setUpgrading(false);
    }
    return data;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const boot = async () => {
      try {
        const first = await refreshStatus();
        if (cancelled) return;
        setReady(true);

        const denseAlready = first.status.backend === "dense";
        if (denseAlready) {
          setUpgrading(false);
        } else {
          // Prefer the dense multilingual model — upgrade then poll until backend flips
          setUpgrading(true);
          void fetch("/api/status", { method: "POST" })
            .then(async (res) => {
              const data = await res.json();
              if (!cancelled) {
                if (!res.ok) {
                  setError(
                    typeof data.error === "string"
                      ? `モデル読込失敗（ハッシュで続行）: ${data.error}`
                      : "モデル読込失敗（ハッシュで続行）",
                  );
                  setUpgrading(false);
                }
                await refreshStatus();
              }
            })
            .catch((e) => {
              if (!cancelled) {
                setError(e instanceof Error ? e.message : "モデル読込失敗");
                setUpgrading(false);
              }
            });
        }

        // Poll until the dense model, reranker, and NLI are ready (they load in
        // the background even when dense is already up).
        if (denseAlready && first.rerankerReady && first.nliReady) return;

        const poll = async () => {
          if (cancelled) return;
          const data = await refreshStatus();
          const onDense = data.status.backend === "dense";
          if (onDense) setUpgrading(false);
          // Keep polling until the dense model, reranker, and NLI are ready.
          if (!onDense || !data.rerankerReady || !data.nliReady) {
            timer = setTimeout(poll, 1500);
          }
        };
        timer = setTimeout(poll, 1000);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "起動に失敗しました");
        }
      }
    };

    void boot();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshStatus]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  async function callChat(
    history: ChatMessage[],
    opts: {
      userText?: string;
      mode?: "reply" | "predict-user" | "chain-plan" | "emit-claim";
      pairCount?: number;
      claim?: string;
      role?: "user" | "bot";
      lang?: string;
      chain?: TraceStep["chain"];
    },
  ): Promise<ChatPayload> {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        history,
        userText: opts.userText,
        mode: opts.mode ?? "reply",
        // Contract: bot replies always run grounded planning.
        generate: true,
        pairCount: opts.pairCount,
        claim: opts.claim,
        role: opts.role,
        lang: opts.lang,
        chain: opts.chain,
      }),
    });
    const data = (await res.json()) as ChatPayload;
    if (!res.ok) throw new Error(data.error || "predict failed");
    if (data.backend === "dense" || data.backend === "hash") {
      setBackend(data.backend);
    }
    setModelId(data.modelId);
    return data;
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy || !ready) return;

    setBusy(true);
    setError(null);
    setInput("");

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      text: trimmed,
    };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);

    try {
      const data = await callChat(nextHistory, { userText: trimmed });
      setMessages((m) => [...m, data.message]);
      setTraces((t) => [data.trace, ...t].slice(0, 12));
    } catch (e) {
      setError(e instanceof Error ? e.message : "予測に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function runChain(steps = 3) {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);

    try {
      let hist = [...messages];

      // G6d: build declarative plan first (audit + freedom: bot stays generate).
      const planned = await callChat(hist, {
        mode: "chain-plan",
        pairCount: steps,
        lang: "ja",
      });
      if (!planned.plan) throw new Error("chain plan missing");
      setChainPlan(planned.plan);
      const plan = planned.plan;

      if (hist.length === 0) {
        const seedText = planned.seedText ?? "連鎖デモお願い";
        const seed: ChatMessage = {
          id: `seed-${Date.now()}`,
          role: "user",
          text: seedText,
        };
        hist = [seed];
        setMessages(hist);
        const first = await callChat(hist, {
          userText: seed.text,
          chain: {
            planId: plan.id,
            stepIndex: -1,
            role: "bot",
            claim: plan.seedClaim,
            resolve: "generate",
            reason: "g6d:seed",
          },
        });
        hist = [...hist, first.message];
        setMessages([...hist]);
        setTraces((t) => [first.trace, ...t].slice(0, 12));
      }

      for (const step of plan.steps) {
        const chainMeta = {
          planId: plan.id,
          stepIndex: step.index,
          role: step.role,
          claim: step.claim,
          resolve: step.resolve,
          reason: step.reason,
        };

        if (step.role === "user" && step.resolve === "corpus" && step.claim) {
          const pred = await callChat(hist, {
            mode: "emit-claim",
            claim: step.claim,
            role: "user",
            lang: plan.lang,
            chain: chainMeta,
          });
          hist = [...hist, pred.message];
          setMessages([...hist]);
          setTraces((t) => [pred.trace, ...t].slice(0, 12));
          continue;
        }

        if (step.role === "bot" && step.resolve === "generate") {
          const lastUser = [...hist].reverse().find((m) => m.role === "user");
          if (!lastUser) throw new Error("chain bot step without user");
          const bot = await callChat(hist, {
            userText: lastUser.text,
            chain: chainMeta,
          });
          hist = [...hist, bot.message];
          setMessages([...hist]);
          setTraces((t) => [bot.trace, ...t].slice(0, 12));
          await new Promise((r) => setTimeout(r, 220));
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "連鎖に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setMessages([]);
    setTraces([]);
    setChainPlan(null);
    setError(null);
  }

  return (
    <div className="relative flex h-dvh max-h-dvh flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-mesh" aria-hidden />
      <div
        className="pointer-events-none absolute -top-32 right-0 h-96 w-96 rounded-full bg-[radial-gradient(circle,var(--nalm-glow)_0%,transparent_70%)] opacity-70 blur-2xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-0 left-0 h-80 w-80 rounded-full bg-[radial-gradient(circle,var(--nalm-glow-2)_0%,transparent_70%)] opacity-50 blur-2xl"
        aria-hidden
      />

      <div className="relative mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-hidden px-4 py-4 md:px-6 md:py-6">
        <header className="mb-4 shrink-0 animate-in-fade md:mb-5">
          <p className="font-mono text-[11px] tracking-[0.22em] text-[var(--nalm-ink-mute)] uppercase">
            multilingual · chunk-kv · no generation
          </p>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-4xl leading-none tracking-tight text-[var(--nalm-ink)] md:text-6xl">
            NOT A LM
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--nalm-ink-soft)] md:text-base">
            多言語埋め込みで会話パターンを探し、チャンクKVの value
            を連鎖させるだけの装置。日本語・英語・中国語で話せるが、言語モデルではない。
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href="/corpus">
                <FilePenLine className="size-3.5" />
                Corpus
              </Link>
            </Button>
            <Badge
              variant="secondary"
              className={cn(
                "font-mono text-[11px]",
                backend === "dense" && "bg-[var(--nalm-accent-soft)]",
              )}
            >
              {backend === "dense" ? "multilingual-MiniLM" : "hash (boot)"}
            </Badge>
            <Badge variant="outline" className="max-w-[min(100%,22rem)] truncate font-mono text-[11px]">
              {modelId}
            </Badge>
            <Badge variant="outline" className="font-mono text-[11px]">
              chunks: {chunkCount || "—"}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-[11px]",
                rerankerReady && "bg-[var(--nalm-accent-soft)]",
              )}
            >
              {rerankerReady ? "+rerank" : "rerank…"}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-[11px]",
                nliReady && "bg-[var(--nalm-accent-soft)]",
              )}
            >
              {nliReady ? "+nli" : "nli…"}
            </Badge>
            {upgrading && (
              <Badge variant="outline" className="gap-1 font-mono text-[11px]">
                <Loader2 className="size-3 animate-spin" />
                {progress || "モデル読込中"}
              </Badge>
            )}
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1.2fr)_minmax(0,0.8fr)] gap-4 lg:grid-cols-[1.2fr_0.8fr] lg:grid-rows-1 lg:items-stretch">
          <section className="flex min-h-0 flex-col rounded-2xl border border-[var(--nalm-line)] bg-[var(--nalm-panel)]/80 shadow-[0_20px_60px_-40px_rgba(20,40,30,0.45)] backdrop-blur-md lg:min-h-0">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--nalm-line)] px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-[var(--nalm-ink-soft)]">
                <Zap className="size-4 text-[var(--nalm-accent)]" />
                会話面
              </div>
              <div className="flex gap-2">
                <Button
                  variant="default"
                  size="sm"
                  disabled
                  title="契約: bot 返答は常に接地生成（コピー＋閉じた糊）。トグルは廃止。"
                  className="gap-1 bg-[var(--nalm-accent)] text-[var(--nalm-ink)] opacity-90"
                >
                  <Sparkles className="size-3.5" />
                  接地 常時
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void runChain(3)}
                  disabled={!ready || busy}
                  className="gap-1"
                >
                  <Link2 className="size-3.5" />
                  連鎖
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={reset}
                  disabled={busy}
                  className="gap-1"
                >
                  <RotateCcw className="size-3.5" />
                  リセット
                </Button>
              </div>
            </div>

            <div
              ref={chatScrollRef}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4"
            >
              {!ready && (
                <div className="flex items-center gap-2 text-sm text-[var(--nalm-ink-mute)]">
                  <Loader2 className="size-4 animate-spin" />
                  {progress || "起動中…"}
                </div>
              )}

              {ready && messages.length === 0 && (
                <div className="animate-in-fade space-y-4 py-6">
                  <p className="text-sm text-[var(--nalm-ink-soft)]">
                    まだ何も連鎖していない。下の候補を押すか、自由に話しかけてみて。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => void send(s)}
                        className="rounded-full border border-[var(--nalm-line)] bg-white/50 px-3 py-1.5 text-left text-xs text-[var(--nalm-ink)] transition hover:border-[var(--nalm-accent)] hover:bg-[var(--nalm-accent-soft)]"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((m) => (
                <div
                  key={m.id}
                  className={cn(
                    "animate-in-up flex",
                    m.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[90%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed md:max-w-[80%]",
                      m.role === "user"
                        ? "bg-[var(--nalm-ink)] text-[var(--nalm-panel)]"
                        : "bg-[var(--nalm-bot-bubble)] text-[var(--nalm-ink)]",
                    )}
                  >
                    <div className="mb-1 flex items-center gap-2 font-mono text-[10px] tracking-wider uppercase opacity-60">
                      <span>{m.role === "user" ? "you" : "not-a-lm"}</span>
                      {m.score != null && <span>cos {m.score.toFixed(3)}</span>}
                      {m.sourceChunkId && <span>{m.sourceChunkId}</span>}
                    </div>
                    {m.text}
                  </div>
                </div>
              ))}

              {busy && (
                <div className="flex items-center gap-2 text-xs text-[var(--nalm-ink-mute)]">
                  <Loader2 className="size-3.5 animate-spin" />
                  近傍探索中…
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-[var(--nalm-line)] p-3">
              {error && (
                <p className="mb-2 text-xs text-red-700" role="alert">
                  {error}
                </p>
              )}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(input);
                }}
              >
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="何か話しかけて（Ctrl+Enter で送信）"
                  rows={2}
                  disabled={!ready || busy}
                  className="min-h-[52px] resize-none bg-white/70"
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (!e.ctrlKey && !e.metaKey) return;
                    e.preventDefault();
                    void send(input);
                  }}
                />
                <Button
                  type="submit"
                  disabled={!ready || busy || !input.trim()}
                  className="h-auto self-stretch bg-[var(--nalm-accent)] px-4 text-[var(--nalm-ink)] hover:bg-[var(--nalm-accent-hot)]"
                >
                  <ArrowRight className="size-4" />
                </Button>
              </form>
            </div>
          </section>

          <aside className="flex min-h-0 flex-col rounded-2xl border border-[var(--nalm-line)] bg-[var(--nalm-panel)]/70 backdrop-blur-md lg:min-h-0">
            <div className="shrink-0 border-b border-[var(--nalm-line)] px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-[var(--nalm-ink-soft)]">
                <Sparkles className="size-4 text-[var(--nalm-accent)]" />
                チャンクKVトレース
              </div>
              <p className="mt-1 text-xs text-[var(--nalm-ink-mute)]">
                user↔bot ペアを局所クラスタリングし、指数加重平均した多言語クエリ。
              </p>
              {chainPlan && (
                <div className="mt-2 rounded-lg bg-black/[0.03] px-2 py-1.5 font-mono text-[10px] text-[var(--nalm-ink-soft)]">
                  <p className="text-[var(--nalm-accent)]">
                    chain-plan · {formatChainPlan(chainPlan)}
                  </p>
                  <p className="text-[var(--nalm-ink-mute)]">
                    {chainPlan.reasons.join(" · ")}
                  </p>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4">
              {traces.length === 0 ? (
                <p className="text-sm text-[var(--nalm-ink-mute)]">
                  まだトレースなし。会話すると類似度ランキングが流れる。
                </p>
              ) : (
                traces.map((tr, i) => (
                  <div
                    key={`${tr.chosen.chunk.id}-${i}-${tr.latencyMs}`}
                    className="animate-in-fade rounded-xl border border-[var(--nalm-line)] bg-white/40 p-3"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] text-[var(--nalm-ink-mute)]">
                        {tr.latencyMs}ms · top-{tr.hits.length}
                        {tr.queryLang ? ` · ${tr.queryLang}` : ""}
                        {tr.reranked ? " · gated" : ""}
                        {tr.topRerankScore != null
                          ? ` · conf ${tr.topRerankScore.toFixed(2)}`
                          : ""}
                        {tr.topCosine != null ? ` · cos ${tr.topCosine.toFixed(2)}` : ""}
                        {tr.nliLabel
                          ? ` · nli ${tr.nliLabel}${tr.nliScore != null ? ` ${tr.nliScore.toFixed(2)}` : ""}`
                          : ""}
                        {tr.operation === "negate-correct" ? " · corrected" : ""}
                        {tr.operation === "affirm-confirm" ? " · confirmed" : ""}
                        {tr.operation === "fuse"
                          ? ` · fused +${tr.fusedWith ?? ""}`
                          : ""}
                        {tr.operation === "compose"
                          ? ` · compose${tr.composePlan?.prefix ? ` (${tr.composePlan.prefix})` : ""}${tr.composePlan?.kept?.length ? ` ${tr.composePlan.kept.map((k) => k.spanId).join("+")}` : ""}`
                          : ""}
                        {tr.retrievalSource === "span"
                          ? ` · span→${tr.matchedSpanId ?? "?"}`
                          : ""}
                      </span>
                      {tr.lowConfidence ? (
                        <Badge
                          variant="outline"
                          className="border-amber-400 text-[10px] text-amber-700"
                        >
                          low-confidence
                        </Badge>
                      ) : tr.rescued ? (
                        <Badge
                          variant="outline"
                          className="border-sky-400 text-[10px] text-sky-700"
                        >
                          cos-rescued
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">
                          {tr.chosen.chunk.speaker} / {tr.chosen.chunk.id}
                        </Badge>
                      )}
                    </div>
                    <p className="mb-2 font-mono text-[11px] text-[var(--nalm-ink-mute)]">
                      {tr.querySummary || tr.queryText}
                    </p>
                    {tr.timingMs && (
                      <p className="mb-2 font-mono text-[10px] text-[var(--nalm-ink-mute)]">
                        timing ·
                        {tr.timingMs.context != null
                          ? ` ctx ${tr.timingMs.context}`
                          : ""}
                        {tr.timingMs.queryEmbed != null
                          ? ` embed ${tr.timingMs.queryEmbed}`
                          : ""}
                        {tr.timingMs.retrieve != null
                          ? ` ret ${tr.timingMs.retrieve}`
                          : ""}
                        {tr.timingMs.gate != null
                          ? ` gate ${tr.timingMs.gate}`
                          : ""}
                        {tr.timingMs.polarity != null
                          ? ` nli ${tr.timingMs.polarity}`
                          : ""}
                        {tr.timingMs.fuse != null
                          ? ` fuse ${tr.timingMs.fuse}`
                          : ""}
                        {tr.timingMs.single != null
                          ? ` single ${tr.timingMs.single}`
                          : ""}
                        {tr.timingMs.selectRender != null
                          ? ` sel ${tr.timingMs.selectRender}`
                          : ""}
                        {tr.timingMs.total != null
                          ? ` Σ ${tr.timingMs.total}`
                          : ""}
                        ms
                      </p>
                    )}
                    {tr.debug && (
                      <details className="mb-2 rounded-lg border border-[var(--nalm-line)] bg-black/[0.03] p-2">
                        <summary className="cursor-pointer font-mono text-[10px] text-[var(--nalm-ink-soft)]">
                          debug · {tr.debug.anaphora}
                          {tr.debug.continuityApplied ? " · cont" : ""}
                          {tr.debug.winnerPlanId
                            ? ` · win=${tr.debug.winnerPlanId}`
                            : ""}
                          {tr.debug.notes.length
                            ? ` · ${tr.debug.notes.slice(0, 2).join(",")}`
                            : ""}
                        </summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-[var(--nalm-ink-mute)]">
                          {JSON.stringify(tr.debug, null, 2)}
                        </pre>
                        <button
                          type="button"
                          className="mt-1 font-mono text-[10px] text-[var(--nalm-accent)] underline"
                          onClick={() => {
                            void navigator.clipboard?.writeText(
                              JSON.stringify(
                                {
                                  reply: messages.find(
                                    (m) =>
                                      m.sourceChunkId === tr.chosen.chunk.id &&
                                      m.role === "bot",
                                  )?.text,
                                  chosen: tr.chosen.chunk.id,
                                  operation: tr.operation,
                                  timingMs: tr.timingMs,
                                  debug: tr.debug,
                                  topRerankScore: tr.topRerankScore,
                                  topCosine: tr.topCosine,
                                  lowConfidence: tr.lowConfidence,
                                  hits: tr.hits.slice(0, 5).map((h) => ({
                                    id: h.chunk.id,
                                    score: h.score,
                                    rerank: h.rerankScore,
                                  })),
                                },
                                null,
                                2,
                              ),
                            );
                          }}
                        >
                          copy debug JSON
                        </button>
                      </details>
                    )}
                    {tr.operationPlan && tr.operationPlan.steps.length > 0 && (
                      <div className="mb-2 space-y-1 rounded-lg bg-black/[0.03] px-2 py-1.5 font-mono text-[10px] text-[var(--nalm-ink-soft)]">
                        <p className="text-[var(--nalm-accent)]">
                          plan · {formatOperationPlan(tr.operationPlan)}
                        </p>
                        {tr.operationPlan.reasons.length > 0 && (
                          <p className="text-[var(--nalm-ink-mute)]">
                            {tr.operationPlan.reasons.join(" · ")}
                          </p>
                        )}
                      </div>
                    )}
                    {tr.chain && (
                      <div className="mb-2 space-y-0.5 rounded-lg bg-black/[0.03] px-2 py-1.5 font-mono text-[10px] text-[var(--nalm-ink-mute)]">
                        <p className="text-[var(--nalm-accent)]">
                          chain[{tr.chain.stepIndex}] · {tr.chain.role}/
                          {tr.chain.resolve}
                          {tr.chain.claim ? ` · ${tr.chain.claim}` : ""}
                        </p>
                        <p>{tr.chain.reason}</p>
                      </div>
                    )}
                    {(tr.priorGrounding ||
                      tr.turnGrounding ||
                      tr.anaphora ||
                      tr.continuity) && (
                      <div className="mb-2 space-y-0.5 rounded-lg bg-black/[0.03] px-2 py-1.5 font-mono text-[10px] text-[var(--nalm-ink-mute)]">
                        {tr.anaphora && tr.anaphora !== "none" && (
                          <p>anaphora · {tr.anaphora}</p>
                        )}
                        {tr.continuity && (
                          <p>
                            continuity · {tr.continuity.claim ?? tr.continuity.chunkId}
                            {tr.continuity.matchedChosen ? " ✓" : ""}
                          </p>
                        )}
                        {tr.priorGrounding && (
                          <p>
                            prior · {formatTurnGrounding(tr.priorGrounding)}
                          </p>
                        )}
                        {tr.turnGrounding && (
                          <p>
                            grounding · {formatTurnGrounding(tr.turnGrounding)}
                          </p>
                        )}
                      </div>
                    )}
                    {tr.queryPairs && tr.queryPairs.length > 0 && (
                      <ul className="mb-2 space-y-1.5 rounded-lg bg-black/[0.03] px-2 py-1.5 font-mono text-[10px] text-[var(--nalm-ink-mute)]">
                        {tr.queryPairs.map((qp) => (
                          <li
                            key={`pair-${qp.index}`}
                            className={cn(!qp.included && "opacity-40 line-through")}
                          >
                            <div className="flex flex-wrap gap-x-1.5">
                              <span>P{qp.index}</span>
                              <span className="max-w-[10rem] truncate">U: {qp.userText}</span>
                              <span>a={qp.anchorSimilarity.toFixed(2)}</span>
                              {qp.chainSimilarity != null && (
                                <span>c={qp.chainSimilarity.toFixed(2)}</span>
                              )}
                              {qp.included && <span>w={qp.finalWeight.toFixed(2)}</span>}
                            </div>
                            {qp.botText && (
                              <div className="truncate opacity-80">B: {qp.botText}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {tr.queryTurns && tr.queryTurns.length > 0 && !tr.queryPairs?.length && (
                      <ul className="mb-2 space-y-1 rounded-lg bg-black/[0.03] px-2 py-1.5 font-mono text-[10px] text-[var(--nalm-ink-mute)]">
                        {tr.queryTurns.map((qt, qi) => (
                          <li
                            key={`${qi}-${qt.text.slice(0, 12)}`}
                            className={cn(
                              "flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5",
                              !qt.included && "opacity-40 line-through",
                            )}
                          >
                            <span>{qt.role === "user" ? "U" : "B"}</span>
                            <span className="max-w-[12rem] truncate">{qt.text}</span>
                            <span>
                              w={qt.finalWeight.toFixed(2)} sim={qt.anchorSimilarity.toFixed(2)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <Separator className="my-2" />
                    <ul className="space-y-1.5">
                      {tr.hits.map((h, j) => (
                        <li
                          key={h.chunk.id}
                          className={cn(
                            "rounded-lg px-2 py-1.5 text-xs",
                            j === 0 ? "bg-[var(--nalm-accent-soft)]" : "bg-transparent",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-[var(--nalm-ink-mute)]">
                            <span>
                              #{j + 1} {h.chunk.id}
                            </span>
                            <span>
                              {h.rerankScore != null
                                ? `rr ${h.rerankScore.toFixed(3)} · cos ${h.score.toFixed(3)}`
                                : h.score.toFixed(3)}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[var(--nalm-ink)]">
                            <span className="text-[var(--nalm-ink-mute)]">V:</span>{" "}
                            {h.chunk.value}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>

            <div className="shrink-0 border-t border-[var(--nalm-line)] p-4 text-xs leading-relaxed text-[var(--nalm-ink-mute)]">
              埋め込みは{" "}
              <a
                className="underline decoration-[var(--nalm-accent)] underline-offset-2 hover:text-[var(--nalm-ink)]"
                href="https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
                target="_blank"
                rel="noreferrer"
              >
                paraphrase-multilingual-MiniLM-L12-v2
              </a>
              （ja/en/zh）。起動直後はハッシュで仮索引し、多言語モデル準備後に差し替える。
            </div>
          </aside>
        </div>

        <footer className="mt-3 hidden shrink-0 flex-col gap-1 text-[11px] text-[var(--nalm-ink-mute)] md:mt-4 md:flex md:flex-row md:items-center md:justify-between">
          <span>
            親戚: retrieval-only chatbot / response selection / kNN-LM / RETRO /
            Memory Networks
          </span>
          <span className="font-mono">generate() === undefined</span>
        </footer>
      </div>
    </div>
  );
}
