import { NextResponse } from "next/server";
import { getEngine } from "@/lib/notalm/engine";
import {
  CHAIN_SEED_USER_TEXT,
} from "@/lib/notalm/chain-plan";
import { detectLang } from "@/lib/notalm/lang";
import type { ChatMessage, Lang } from "@/lib/notalm/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  history?: ChatMessage[];
  userText?: string;
  mode?: "reply" | "predict-user" | "chain-plan" | "emit-claim";
  generate?: boolean;
  /** Clear reuse penalty between eval cases */
  resetSession?: boolean;
  /** G6d */
  lang?: Lang;
  pairCount?: number;
  userClaimOffset?: number;
  claim?: string;
  role?: "user" | "bot";
  chain?: {
    planId: string;
    stepIndex: number;
    role: "user" | "bot";
    claim?: string;
    resolve: "corpus" | "generate";
    reason: string;
  };
};

export async function POST(req: Request) {
  const engine = getEngine();
  await engine.ensureHash();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const history = body.history ?? [];
  const mode = body.mode ?? "reply";

  try {
    if (mode === "chain-plan") {
      const lang: Lang =
        body.lang ??
        (history.length
          ? detectLang(
              [...history].reverse().find((m) => m.role === "user")?.text ??
                CHAIN_SEED_USER_TEXT.ja,
            )
          : "ja");
      const plan = engine.buildChainPlan(
        lang,
        body.pairCount ?? 3,
        body.userClaimOffset ?? 0,
      );
      return NextResponse.json({
        plan,
        seedText: CHAIN_SEED_USER_TEXT[lang],
        backend: engine.status.kind === "ready" ? engine.status.backend : "hash",
        modelId: engine.modelId,
      });
    }

    if (mode === "emit-claim") {
      if (!body.claim || !body.role) {
        return NextResponse.json(
          { error: "claim and role required" },
          { status: 400 },
        );
      }
      const lang: Lang = body.lang ?? "ja";
      const result = await engine.emitClaim({
        claim: body.claim,
        lang,
        role: body.role,
        chain: body.chain,
      });
      return NextResponse.json({
        ...result,
        backend: engine.status.kind === "ready" ? engine.status.backend : "hash",
        modelId: engine.modelId,
      });
    }

    if (mode === "predict-user") {
      const result = await engine.predictUser(history, { chain: body.chain });
      return NextResponse.json({
        ...result,
        backend: engine.status.kind === "ready" ? engine.status.backend : "hash",
        modelId: engine.modelId,
      });
    }

    const userText = (body.userText ?? "").trim();
    if (!userText) {
      return NextResponse.json({ error: "userText required" }, { status: 400 });
    }

    if (body.resetSession) engine.resetMemory();

    const result = await engine.reply(history, userText, {
      // Contract: bot path always grounds; flag kept for older clients.
      generate: body.generate !== false,
      chain: body.chain,
    });
    return NextResponse.json({
      ...result,
      backend: engine.status.kind === "ready" ? engine.status.backend : "hash",
      modelId: engine.modelId,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "predict failed" },
      { status: 500 },
    );
  }
}
