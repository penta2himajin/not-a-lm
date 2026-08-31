/**
 * G6 — multi-turn grounding helpers (copy-only).
 *
 * G6a: attach TurnGrounding to replies and read prior bot grounding from history.
 * Resolution / clarify planners land in G6b+.
 */

import type {
  ChatMessage,
  ChunkRecord,
  ComposePlan,
  FusePartTrace,
  Lang,
  SpanRef,
  TurnGrounding,
} from "./types.ts";

export type OperationLabel =
  | "as-is"
  | "negate-correct"
  | "affirm-confirm"
  | "fuse"
  | "compose";

function textsForKept(
  chunk: ChunkRecord | undefined,
  kept: SpanRef[] | undefined,
): string[] {
  if (!chunk) return [];
  if (kept?.length && chunk.spans?.length) {
    const out: string[] = [];
    for (const ref of kept) {
      if (ref.chunkId !== chunk.id) continue;
      const sp = chunk.spans.find((s) => s.id === ref.spanId);
      if (sp?.text) out.push(sp.text);
    }
    if (out.length) return out;
  }
  return chunk.value ? [chunk.value] : [];
}

/** Build grounding for the reply just produced (G6a). */
export function buildTurnGrounding(input: {
  chunk: ChunkRecord;
  operation?: OperationLabel;
  composePlan?: ComposePlan;
  fuseParts?: FusePartTrace[];
  getChunk?: (id: string) => ChunkRecord | undefined;
}): TurnGrounding {
  const { chunk, operation, composePlan, fuseParts, getChunk } = input;
  const kept = composePlan?.kept;
  const excerptTexts = textsForKept(chunk, kept);

  const parts: NonNullable<TurnGrounding["parts"]> = [];
  if (fuseParts?.length && getChunk) {
    for (const fp of fuseParts) {
      if (fp.chunkId === chunk.id) continue;
      const c = getChunk(fp.chunkId);
      if (!c) continue;
      parts.push({
        chunkId: c.id,
        claim: c.claim,
        excerptTexts: textsForKept(c, fp.composePlan?.kept),
      });
    }
  }

  return {
    chunkId: chunk.id,
    claim: chunk.claim,
    lang: chunk.lang as Lang,
    kept: kept?.filter((k) => k.chunkId === chunk.id),
    excerptTexts,
    operation,
    parts: parts.length ? parts : undefined,
  };
}

/** Last bot message that carries grounding (for proximal / clarify). */
export function lastBotGrounding(
  history: ChatMessage[],
): TurnGrounding | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "bot" && m.grounding) return m.grounding;
  }
  return undefined;
}

/** Recent bot groundings, newest first (for non-proximal clarify examples). */
export function recentBotGroundings(
  history: ChatMessage[],
  limit = 3,
): TurnGrounding[] {
  const out: TurnGrounding[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < limit; i--) {
    const m = history[i];
    if (m.role === "bot" && m.grounding) out.push(m.grounding);
  }
  return out;
}

/** One-line audit label for traces / UI. */
export function formatTurnGrounding(g: TurnGrounding): string {
  const claim = g.claim ?? g.chunkId.replace(/-ja$|-en$|-zh$/, "");
  const spans = g.kept?.map((k) => k.spanId).join("+");
  const op = g.operation && g.operation !== "as-is" ? g.operation : undefined;
  const bits = [claim];
  if (spans) bits.push(spans);
  if (op) bits.push(op);
  if (g.parts?.length) bits.push(`+${g.parts.length}`);
  return bits.join("/");
}
