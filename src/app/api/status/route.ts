import { NextResponse } from "next/server";
import { getBekkoProgress, isBekkoReady } from "@/lib/notalm/embed";
import { getEngine } from "@/lib/notalm/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const engine = getEngine();
  await engine.ensureHash();

  // Kick off bekko load in background if not started
  if (!isBekkoReady()) {
    void engine.ensureBekko().catch(() => {
      /* surfaced via progress / status */
    });
  }

  const status = engine.status;
  return NextResponse.json({
    status,
    modelId: engine.modelId,
    progress: getBekkoProgress(),
    bekkoReady: isBekkoReady(),
    chunkCount: engine.corpus.length,
  });
}

export async function POST() {
  const engine = getEngine();
  try {
    await engine.ensureBekko();
    return NextResponse.json({
      ok: true,
      status: engine.status,
      modelId: engine.modelId,
      progress: getBekkoProgress(),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "bekko load failed",
        progress: getBekkoProgress(),
        status: engine.status,
      },
      { status: 500 },
    );
  }
}
