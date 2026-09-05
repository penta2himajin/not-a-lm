/**
 * Offline naturalness LLM-as-judge via OpenRouter.
 *
 * SoT contract (docs/topic-graph-work-sot.md §2):
 * - Scores naturalness / humanlikeness only.
 * - Never scores grounding, factuality, or corpus fidelity.
 * - Pairwise comparison is preferred; absolute scores are auxiliary.
 * - Not used on the production chat path.
 */

export type JudgeWinner = "A" | "B" | "tie";

export type DimensionScores = {
  tempo: number;
  coherence: number;
  humanlikeness: number;
};

export type PairwiseJudgeResult = {
  winner: JudgeWinner;
  scores: { A: DimensionScores; B: DimensionScores };
  rationale: string;
  model: string;
  latencyMs: number;
  /** true when A/B were swapped in the prompt then mapped back */
  positionSwapped: boolean;
  rawText?: string;
};

export type AggregatedPairwise = {
  winner: JudgeWinner;
  votes: { A: number; B: number; tie: number };
  passes: PairwiseJudgeResult[];
  model: string;
};

export type DialogueTurn = { role: "user" | "bot"; text: string };

export type PairwiseCase = {
  id: string;
  lang?: "ja" | "en" | "zh";
  /** Prior turns (optional). Do not include the candidate replies. */
  context?: DialogueTurn[];
  /** Latest user utterance being answered. */
  user: string;
  replyA: string;
  replyB: string;
  /** Optional expected winner for smoke tests (not a gold label). */
  expectWinner?: JudgeWinner;
  notes?: string;
};

export const DEFAULT_JUDGE_MODEL =
  process.env.JUDGE_MODEL?.trim() ||
  "nvidia/nemotron-3-super-120b-a12b:free";

/** Free fallbacks tried on 429 / empty parse (order matters). */
export const JUDGE_MODEL_FALLBACKS: string[] = [
  "minimax/minimax-m2.7:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "openrouter/free",
];

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT = `あなたは対話応答の「自然さ・人間らしさ」だけを採点する審査員です。

【採点してよい】
- テンポ / 間合い（tempo）
- 話題のつながり・一貫性（coherence）: ユーザーの直前発話に応答として噛み合っているか。無関係な話題への飛躍は減点。複合質問では、並置・対比・詳細化など**話題のつなぎ**が自然かも見る（つなぎが無く唐突に並ぶだけの応答は減点）。
- 人間っぽさ・違和感の少なさ（humanlikeness）: ただし雑談への逸脱を「人間らしい」として過大評価しない。質問に答えない応答は不自然。

【優先ルール】
1. ユーザーの質問・依頼に対して応答として成立している方を勝たせる。
2. 前後の会話コンテキストがある場合、話題を維持または自然に深掘りしている方を勝たせる。
3. 複合・対比の問いでは、両側の話題を過不足なくつなぐ方を勝たせる（片方だけ・無関係並置は負け寄り）。
4. 文体が滑らかでも、質問を無視して別話題に飛ぶ応答は負け。

【採点してはいけない】
- 事実の正誤、コーパスへの忠実さ、接地（grounding）
- 技術的な正確さや「正しい説明かどうか」

必ず次の JSON オブジェクトだけを出力してください。前後に説明やコードフェンスを付けないでください。
{"winner":"A"|"B"|"tie","scores":{"A":{"tempo":1-5,"coherence":1-5,"humanlikeness":1-5},"B":{"tempo":1-5,"coherence":1-5,"humanlikeness":1-5}},"rationale":"日本語で1〜2文"}`;

function clampScore(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 1;
  return Math.max(1, Math.min(5, Math.round(x)));
}

function normalizeScores(raw: unknown): DimensionScores {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    tempo: clampScore(o.tempo),
    coherence: clampScore(o.coherence),
    humanlikeness: clampScore(o.humanlikeness),
  };
}

export function extractJsonObject(text: string): unknown | null {
  let s = (text || "").trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(s.slice(i, j + 1));
  } catch {
    return null;
  }
}

function parseJudgePayload(
  text: string,
): Omit<
  PairwiseJudgeResult,
  "model" | "latencyMs" | "positionSwapped" | "rawText"
> | null {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const winner = o.winner;
  if (winner !== "A" && winner !== "B" && winner !== "tie") return null;
  const scores = o.scores;
  if (!scores || typeof scores !== "object") return null;
  const sc = scores as Record<string, unknown>;
  return {
    winner,
    scores: {
      A: normalizeScores(sc.A),
      B: normalizeScores(sc.B),
    },
    rationale: typeof o.rationale === "string" ? o.rationale : "",
  };
}

function formatContext(context: DialogueTurn[] | undefined): string {
  if (!context?.length) return "(なし)";
  return context
    .map((t) => `${t.role === "user" ? "user" : "bot"}: ${t.text}`)
    .join("\n");
}

function buildUserPrompt(
  c: PairwiseCase,
  replyA: string,
  replyB: string,
): string {
  return `言語: ${c.lang ?? "ja"}

会話コンテキスト（直前まで）:
${formatContext(c.context)}

最新のユーザー発話:
user: ${c.user}

応答候補:
[A] ${replyA}
[B] ${replyB}

接地や事実の正しさは無視してください。
ただし「ユーザー発話への応答として噛み合っているか」「話題が飛んでいないか」は自然さ（coherence）として必ず評価してください。`;
}

export type OpenRouterChatOptions = {
  model: string;
  apiKey: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

export async function openRouterChat(
  opts: OpenRouterChatOptions,
): Promise<{ content: string; model: string; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 120_000,
  );
  const t0 = performance.now();
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/penta2himajin/not-a-lm",
        "X-Title": "not-a-lm naturalness-judge",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 800,
      }),
    });
    const latencyMs = Math.round(performance.now() - t0);
    const body = (await res.json()) as {
      error?: { message?: string; code?: number };
      choices?: { message?: { content?: string } }[];
      model?: string;
    };
    if (!res.ok) {
      const msg = body.error?.message || `HTTP ${res.status}`;
      const err = new Error(msg) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    const content = body.choices?.[0]?.message?.content ?? "";
    return { content, model: body.model || opts.model, latencyMs };
  } finally {
    clearTimeout(timeout);
  }
}

function mapSwappedWinner(w: JudgeWinner): JudgeWinner {
  if (w === "A") return "B";
  if (w === "B") return "A";
  return "tie";
}

async function judgeOnce(
  c: PairwiseCase,
  apiKey: string,
  model: string,
  swap: boolean,
): Promise<PairwiseJudgeResult> {
  const replyA = swap ? c.replyB : c.replyA;
  const replyB = swap ? c.replyA : c.replyB;
  const { content, model: used, latencyMs } = await openRouterChat({
    apiKey,
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(c, replyA, replyB) },
    ],
  });
  const parsed = parseJudgePayload(content);
  if (!parsed) {
    throw new Error(
      `judge JSON parse failed (model=${used}): ${content.slice(0, 200)}`,
    );
  }
  if (!swap) {
    return {
      ...parsed,
      model: used,
      latencyMs,
      positionSwapped: false,
      rawText: content,
    };
  }
  return {
    winner: mapSwappedWinner(parsed.winner),
    scores: { A: parsed.scores.B, B: parsed.scores.A },
    rationale: parsed.rationale,
    model: used,
    latencyMs,
    positionSwapped: true,
    rawText: content,
  };
}

function modelQueue(primary: string): string[] {
  const rest = JUDGE_MODEL_FALLBACKS.filter((m) => m !== primary);
  return [primary, ...rest];
}

/**
 * Single pairwise pass (optional position swap). Retries free fallbacks on 429.
 */
export async function judgePairwiseOnce(
  c: PairwiseCase,
  opts: {
    apiKey?: string;
    model?: string;
    swapPositions?: boolean;
  } = {},
): Promise<PairwiseJudgeResult> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const primary = opts.model ?? DEFAULT_JUDGE_MODEL;
  const swap = Boolean(opts.swapPositions);
  let lastErr: unknown;
  for (const model of modelQueue(primary)) {
    try {
      return await judgeOnce(c, apiKey, model, swap);
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      const msg = e instanceof Error ? e.message : String(e);
      const retryable =
        status === 429 ||
        /rate.?limit/i.test(msg) ||
        /JSON parse failed/i.test(msg);
      if (!retryable) throw e;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "judge failed"));
}

function aggregateWinner(votes: { A: number; B: number; tie: number }): JudgeWinner {
  if (votes.A > votes.B && votes.A > votes.tie) return "A";
  if (votes.B > votes.A && votes.B > votes.tie) return "B";
  if (votes.A === votes.B && votes.A > votes.tie) return "tie";
  return "tie";
}

/**
 * Position-debiased pairwise: forward + swapped, majority vote.
 */
export async function judgePairwise(
  c: PairwiseCase,
  opts: { apiKey?: string; model?: string; debias?: boolean } = {},
): Promise<AggregatedPairwise> {
  const debias = opts.debias !== false;
  const passes: PairwiseJudgeResult[] = [];
  passes.push(
    await judgePairwiseOnce(c, {
      apiKey: opts.apiKey,
      model: opts.model,
      swapPositions: false,
    }),
  );
  if (debias) {
    passes.push(
      await judgePairwiseOnce(c, {
        apiKey: opts.apiKey,
        model: opts.model,
        swapPositions: true,
      }),
    );
  }
  const votes = { A: 0, B: 0, tie: 0 };
  for (const p of passes) votes[p.winner] += 1;
  return {
    winner: aggregateWinner(votes),
    votes,
    passes,
    model: passes[0]?.model ?? opts.model ?? DEFAULT_JUDGE_MODEL,
  };
}
