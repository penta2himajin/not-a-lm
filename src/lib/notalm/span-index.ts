/**
 * Dual-index retrieval: natKey (primary) + span-level secondary index.
 *
 * Span entries: author spans (compose-grade) + auto key-spans (retrieval hooks).
 * Merge policy (Boost + rescue): candidates = key top-K ∪ span top-M parents;
 * finalScore = keyScore + SPAN_BOOST_WEIGHT * bestSpanScore.
 */

import { cosine } from "./embed.ts";
import {
  REUSE_PENALTY,
  adjustScoreForContinuity,
  type ContinuityHint,
} from "./grounding.ts";
import type { ChunkRecord, Lang, MatchHit } from "./types.ts";
import { buildAllAutoKeySpans, type AutoKeySpan } from "./key-span.ts";

export type SpanIndexKind = "author" | "key-span";

export type SpanIndexEntry = {
  chunkId: string;
  /** Author span id or auto-{n} */
  entryId: string;
  kind: SpanIndexKind;
  text: string;
  embedding: Float32Array;
};

export type SpanHit = {
  entry: SpanIndexEntry;
  score: number;
  chunk: ChunkRecord;
};

export type DualRetrievalResult = {
  hits: MatchHit[];
  chosen: MatchHit;
  retrievalSource: "natKey" | "span";
  matchedSpanId?: string;
  matchedSpanKind?: SpanIndexKind;
  matchedSpanText?: string;
  spanScore?: number;
  keyOnlyTopClaim?: string;
};

/** How many key hits feed the merge pool */
export const KEY_POOL = 12;
/** Max span hits considered */
export const SPAN_POOL = 10;
/** Weight of author span cosine in combined score */
export const SPAN_BOOST_WEIGHT = 0.42;
/** Extra weight for auto key-spans — boost only within key pool */
export const SPAN_AUTO_BOOST = 0.16;
/** Author span rescue: min cosine to promote parent outside key top-K */
export const SPAN_AUTHOR_RESCUE = 0.82;
/** Stronger weight when rescuing by author span outside the key pool */
export const SPAN_RESCUE_WEIGHT = 0.78;
/** Min span cosine to contribute (auto key-spans) */
export const SPAN_MIN_COS = 0.38;
/** Lower bar for author spans (short texts) */
export const SPAN_AUTHOR_MIN_COS = 0.26;

export function collectSpanTexts(chunk: ChunkRecord): { entryId: string; kind: SpanIndexKind; text: string }[] {
  const out: { entryId: string; kind: SpanIndexKind; text: string }[] = [];
  for (const s of chunk.spans ?? []) {
    if (s.text.trim()) out.push({ entryId: s.id, kind: "author", text: indexTextForSpan(s) });
  }
  return out;
}

/** Prefix closed tags to improve bi-encoder match on short spans (index only). */
export function indexTextForSpan(span: { text: string; tags?: string[] }): string {
  const tags = span.tags ?? [];
  if (tags.includes("retrieval") && tags.includes("mechanism")) {
    return `mechanism retrieval ${span.text}`;
  }
  if (tags.includes("embedding") && tags.includes("retrieval")) {
    return `mechanism retrieval embedding ${span.text}`;
  }
  if (tags.includes("embedding") && tags.includes("mechanism") && tags.includes("paraphrase")) {
    return `embedding semantics ${span.text}`;
  }
  if (tags.includes("embedding") && tags.includes("mechanism")) {
    return `mechanism pipeline embedding ${span.text}`;
  }
  if (tags.includes("embedding")) return `embedding ${span.text}`;
  return span.text;
}

/** True when the query asks how the pipeline uses embeddings (not "what is embedding"). */
export function queryWantsMechanismPipeline(query: string): boolean {
  const q = query.trim();
  if (/what is an? embedding/i.test(q)) return false;
  if (/embedding.*是什么/i.test(q)) return false;
  if (/嵌入.*是什么/i.test(q)) return false;
  if (/埋め込み.*(って何|とは)/u.test(q)) return false;
  if (/embedding/i.test(q) && /work/i.test(q)) return true;
  if (/埋め込み/.test(q) && /働/u.test(q)) return true;
  if (/嵌入/.test(q) && /工作|运作|怎么/u.test(q)) return true;
  if (/mechanism|原理|仕組み|工作原理/.test(q) && /embed|埋め込み|嵌入/i.test(q)) return true;
  return false;
}

/** True when the query asks what embedding IS (conceptual → mech-2). */
export function queryWantsEmbeddingConcept(query: string): boolean {
  const q = query.trim();
  return (
    /what is an? embedding/i.test(q) ||
    /embedding.*是什么/i.test(q) ||
    /嵌入.*是什么/i.test(q) ||
    /埋め込み.*(って何|とは)/u.test(q)
  );
}

/** True when the user asks about capabilities / how to use the demo. */
export function queryWantsHelp(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  return /使い方|ヘルプ|how to use|help|怎么用|何ができる|能做什么|what can you do/i.test(
    q,
  );
}

/**
 * Claims to inject into the CE gate pool when the query clearly targets a topic
 * but bi-encoder nat-key ranking under-ranks the best keyword-key match.
 */
export function topicRescueClaims(query: string): string[] {
  if (queryWantsHelp(query)) return ["help-1", "help-2"];
  return [];
}

export function buildSpanIndexManifest(
  chunks: ChunkRecord[],
): Omit<SpanIndexEntry, "embedding">[] {
  const autoByChunk = buildAllAutoKeySpans(chunks);
  const manifest: Omit<SpanIndexEntry, "embedding">[] = [];

  for (const chunk of chunks) {
    if (chunk.speaker !== "bot") continue;

    for (const s of collectSpanTexts(chunk)) {
      manifest.push({
        chunkId: chunk.id,
        entryId: s.entryId,
        kind: s.kind,
        text: s.text,
      });
    }

    for (const ak of autoByChunk.get(chunk.id) ?? []) {
      manifest.push({
        chunkId: chunk.id,
        entryId: ak.id,
        kind: "key-span",
        text: ak.text,
      });
    }
  }

  return manifest;
}

function chunkFromIndexed(
  chunk: ChunkRecord & { embedding?: Float32Array },
): ChunkRecord {
  const { embedding: _e, ...rest } = chunk as ChunkRecord & { embedding?: Float32Array };
  return rest;
}

export function searchSpanIndex(
  queryVec: Float32Array,
  spanIndex: SpanIndexEntry[],
  chunkById: Map<string, ChunkRecord & { embedding: Float32Array }>,
  lang: Lang | undefined,
  limit: number = SPAN_POOL,
): SpanHit[] {
  const scored: SpanHit[] = [];
  for (const entry of spanIndex) {
    const chunk = chunkById.get(entry.chunkId);
    if (!chunk) continue;
    if (lang && chunk.lang !== lang) continue;
    const score = cosine(queryVec, entry.embedding);
    const minCos =
      entry.kind === "author" ? SPAN_AUTHOR_MIN_COS : SPAN_MIN_COS;
    if (score < minCos) continue;
    scored.push({
      entry,
      score,
      chunk: chunkFromIndexed(chunk),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Merge key ranking with span index.
 * - Author spans: strong boost + rescue outside key top-K when cos ≥ SPAN_AUTHOR_RESCUE
 * - Auto key-spans: mild boost only for chunks already in key top-K
 */
export function mergeDualRetrieval(
  queryVec: Float32Array,
  keyHits: MatchHit[],
  spanHits: SpanHit[],
  chunkById: Map<string, ChunkRecord & { embedding: Float32Array }>,
  usedIds: Set<string>,
  queryText = "",
  continuity?: ContinuityHint,
): DualRetrievalResult {
  const keyPool = keyHits.slice(0, KEY_POOL);
  const keyOnlyTop = keyPool[0];
  const keyScoreById = new Map(keyPool.map((h) => [h.chunk.id, h.score]));

  const bestAuthorByChunk = new Map<string, SpanHit>();
  const bestAutoByChunk = new Map<string, SpanHit>();
  for (const sh of spanHits) {
    const map = sh.entry.kind === "author" ? bestAuthorByChunk : bestAutoByChunk;
    const prev = map.get(sh.chunk.id);
    if (!prev || sh.score > prev.score) map.set(sh.chunk.id, sh);
  }

  const candidateIds = new Set<string>();
  for (const h of keyPool) candidateIds.add(h.chunk.id);
  for (const sh of spanHits) {
    if (sh.entry.kind !== "author") continue;
    if (sh.score < SPAN_AUTHOR_RESCUE) continue;
    candidateIds.add(sh.chunk.id);
  }

  const keyTopScore = keyOnlyTop?.score ?? 0;

  const wantsPipeline = queryWantsMechanismPipeline(queryText);
  const wantsConcept = queryWantsEmbeddingConcept(queryText);
  const wantsHelp = queryWantsHelp(queryText);

  type Ranked = {
    chunk: ChunkRecord;
    keyScore: number;
    spanScore: number;
    finalScore: number;
    spanHit?: SpanHit;
    authorRescue: boolean;
  };

  const ranked: Ranked[] = [];
  for (const id of candidateIds) {
    const chunk = chunkById.get(id);
    if (!chunk) continue;
    const inPool = keyScoreById.has(id);
    let keyScore = keyScoreById.get(id);
    if (keyScore === undefined) {
      keyScore = cosine(queryVec, chunk.embedding);
      // Rescued-only parents were not in keyHits — apply reuse/continuity here.
      keyScore = adjustScoreForContinuity(
        keyScore,
        chunk,
        usedIds,
        continuity,
        REUSE_PENALTY,
      ).score;
    } else if (!continuity) {
      // Legacy: keyHits already include one reuse penalty from search; keep the
      // historical second subtract when no G6c continuity hint is active.
      if (usedIds.has(id)) keyScore -= REUSE_PENALTY;
    }
    // With continuity, engine.search already applied adjustScoreForContinuity.

    const authorHit = bestAuthorByChunk.get(id);
    const autoHit = bestAutoByChunk.get(id);
    const authorScore = authorHit?.score ?? 0;
    const autoScore = autoHit?.score ?? 0;
    const authorRescue = !inPool && authorScore >= SPAN_AUTHOR_RESCUE;

    let spanContribution = 0;
    if (authorScore >= SPAN_AUTHOR_MIN_COS) {
      spanContribution += authorRescue
        ? SPAN_RESCUE_WEIGHT * authorScore
        : SPAN_BOOST_WEIGHT * authorScore;
    }
    if (inPool && autoScore >= SPAN_MIN_COS) {
      // Auto key-spans disambiguate mid-ranked key hits, not close #2 over #1
      if (keyScore <= keyTopScore - 0.06) {
        const autoBoost = SPAN_AUTO_BOOST * autoScore;
        // Never dethrone the key-only leader via auto key-span alone
        if (keyScore + autoBoost <= keyTopScore + 0.005) {
          spanContribution += autoBoost;
        }
      }
    }

    const projected = keyScore + spanContribution;
    if (authorRescue && projected <= keyTopScore + 0.02) continue;

    let claimAdjust = 0;
    if (wantsPipeline && chunk.claim === "mech-1") claimAdjust += 0.1;
    if (wantsPipeline && chunk.claim === "mech-2") claimAdjust -= 0.12;
    if (wantsConcept && chunk.claim === "mech-2") claimAdjust += 0.1;
    if (wantsConcept && chunk.claim === "mech-1") claimAdjust -= 0.08;
    if (wantsHelp && (chunk.claim === "help-1" || chunk.claim === "help-2")) {
      claimAdjust += 0.12;
    }
    if (wantsHelp && /^code-/.test(chunk.claim)) {
      claimAdjust -= 0.1;
      spanContribution = 0;
    }
    // 「何ができる」is capability/help — not smalltalk hobby banter.
    if (wantsHelp && /^hobby-/.test(chunk.claim ?? "")) {
      claimAdjust -= 0.12;
      spanContribution = 0;
    }

    const bestSpanHit =
      authorHit && (!autoHit || authorHit.score >= autoHit.score)
        ? authorHit
        : autoHit;
    const spanScore = Math.max(authorScore, inPool ? autoScore : 0);

    ranked.push({
      chunk: chunkFromIndexed(chunk),
      keyScore,
      spanScore,
      finalScore: keyScore + spanContribution + claimAdjust,
      spanHit: bestSpanHit,
      authorRescue,
    });
  }

  ranked.sort((a, b) => b.finalScore - a.finalScore);
  const winner = ranked[0];
  if (!winner) {
    const fallback = keyPool[0] ?? keyHits[0];
    return {
      hits: keyHits,
      chosen: fallback,
      retrievalSource: "natKey",
      keyOnlyTopClaim: keyOnlyTop?.chunk.claim,
    };
  }

  const keyWinnerId = keyOnlyTop?.chunk.id;
  let spanDriven =
    winner.spanHit != null &&
    winner.spanScore >= SPAN_AUTHOR_MIN_COS &&
    winner.finalScore > keyTopScore + 0.01 &&
    (winner.authorRescue ||
      winner.chunk.id !== keyWinnerId ||
      (bestAuthorByChunk.get(winner.chunk.id)?.score ?? 0) >=
        SPAN_AUTHOR_MIN_COS + 0.05 ||
      (winner.spanHit?.entry.kind === "key-span" &&
        winner.spanScore >= SPAN_AUTHOR_RESCUE));
  if (wantsHelp && /^code-/.test(winner.chunk.claim)) {
    spanDriven = false;
  }

  const chosen: MatchHit = {
    chunk: winner.chunk,
    score: winner.finalScore,
    spanScore: winner.spanScore,
  };

  const hits: MatchHit[] = ranked.slice(0, 5).map((r) => ({
    chunk: r.chunk,
    score: r.finalScore,
    spanScore: r.spanScore,
  }));

  return {
    hits,
    chosen,
    retrievalSource:
      spanDriven && winner.spanHit ? "span" : "natKey",
    matchedSpanId: spanDriven ? winner.spanHit?.entry.entryId : undefined,
    matchedSpanKind: spanDriven ? winner.spanHit?.entry.kind : undefined,
    matchedSpanText: spanDriven ? winner.spanHit?.entry.text : undefined,
    spanScore: winner.spanScore || undefined,
    keyOnlyTopClaim: keyOnlyTop?.chunk.claim,
  };
}
