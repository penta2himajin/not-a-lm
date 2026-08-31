import { NextResponse } from "next/server";
import { DENSE_MODEL_LABEL, EMBED_DTYPE, getDenseProgress, isDenseReady } from "@/lib/notalm/embed";
import {
  RERANK_DTYPE,
  RERANK_MODEL_LABEL,
  getRerankerProgress,
  isRerankerReady,
  loadReranker,
} from "@/lib/notalm/rerank";
import {
  NLI_DTYPE,
  NLI_MODEL_LABEL,
  getNliProgress,
  isNliReady,
  loadNli,
} from "@/lib/notalm/nli";
import { getEngine } from "@/lib/notalm/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const engine = getEngine();
  await engine.ensureHash();

  // Kick off dense-model load in background if not started
  if (!isDenseReady()) {
    void engine.ensureDense().catch(() => {
      /* surfaced via progress / status */
    });
  }

  // Kick off reranker load in background (stage-2 quality upgrade)
  if (!isRerankerReady()) {
    void loadReranker().catch(() => {
      /* surfaced via reranker progress */
    });
  }

  // Kick off NLI load in background (stage-3 grounded generation)
  if (!isNliReady()) {
    void loadNli().catch(() => {
      /* surfaced via nli progress */
    });
  }

  const status = engine.status;
  return NextResponse.json({
    status,
    modelId: engine.modelId,
    progress: getDenseProgress(),
    denseReady: isDenseReady(),
    embedLabel: DENSE_MODEL_LABEL,
    embedDtype: EMBED_DTYPE,
    rerankerReady: isRerankerReady(),
    rerankerLabel: RERANK_MODEL_LABEL,
    rerankerDtype: RERANK_DTYPE,
    rerankerProgress: getRerankerProgress(),
    nliReady: isNliReady(),
    nliLabel: NLI_MODEL_LABEL,
    nliDtype: NLI_DTYPE,
    nliProgress: getNliProgress(),
    chunkCount: engine.corpus.length,
  });
}

export async function POST() {
  const engine = getEngine();
  try {
    await engine.ensureDense();
    return NextResponse.json({
      ok: true,
      status: engine.status,
      modelId: engine.modelId,
      progress: getDenseProgress(),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "dense load failed",
        progress: getDenseProgress(),
        status: engine.status,
      },
      { status: 500 },
    );
  }
}
