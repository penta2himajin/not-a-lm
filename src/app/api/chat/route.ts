import { NextResponse } from "next/server";
import { getEngine } from "@/lib/notalm/engine";
import type { ChatMessage } from "@/lib/notalm/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  history?: ChatMessage[];
  userText?: string;
  mode?: "reply" | "predict-user";
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
    if (mode === "predict-user") {
      const result = await engine.predictUser(history);
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

    const result = await engine.reply(history, userText);
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
