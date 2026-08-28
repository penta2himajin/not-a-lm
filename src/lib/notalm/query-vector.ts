import { cosine, embed, embedMany, type EmbedBackend } from "./embed";
import type { ChatMessage, Speaker } from "./types";

/** Max turns considered for query composition */
export const QUERY_MAX_TURNS = 6;

/** exp(-λ * age): higher λ → faster decay of older turns */
export const QUERY_DECAY_LAMBDA = 0.55;

/** Extra multiplier on the newest user utterance */
export const QUERY_USER_BOOST = 2.5;

/** Drop history turns whose cosine to anchor falls below this (anchor always kept) */
export const QUERY_MIN_ANCHOR_SIM = 0.22;

export type QueryTurnDetail = {
  role: Speaker;
  text: string;
  age: number;
  baseWeight: number;
  finalWeight: number;
  anchorSimilarity: number;
  included: boolean;
};

export type ComposedQuery = {
  vector: Float32Array;
  /** Human-readable trace line */
  summary: string;
  turns: QueryTurnDetail[];
  anchorText: string;
};

function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  if (sumSq === 0) return vec;
  const inv = 1 / Math.sqrt(sumSq);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] * inv;
  return out;
}

function weightedAverage(vectors: Float32Array[], weights: number[]): Float32Array {
  const dim = vectors[0]?.length ?? 384;
  const acc = new Float32Array(dim);
  let wSum = 0;
  for (let t = 0; t < vectors.length; t++) {
    const w = weights[t];
    if (w <= 0) continue;
    wSum += w;
    const v = vectors[t];
    for (let i = 0; i < dim; i++) acc[i] += v[i] * w;
  }
  if (wSum === 0) return acc;
  for (let i = 0; i < dim; i++) acc[i] /= wSum;
  return l2Normalize(acc);
}

/**
 * Build query vector from per-turn embeddings with exponential recency weighting.
 * Anchor = newest user text (latestUser or last user in history).
 * Turns too distant from anchor are excluded unless they are the anchor itself.
 */
export async function composeQueryVector(
  history: ChatMessage[],
  latestUser: string | undefined,
  backend: EmbedBackend,
): Promise<ComposedQuery> {
  const recent = history.slice(-QUERY_MAX_TURNS);
  const turns: { role: Speaker; text: string; isLatestUser: boolean }[] =
    recent.map((m) => ({
      role: m.role,
      text: m.text,
      isLatestUser: false,
    }));

  if (latestUser?.trim()) {
    turns.push({
      role: "user",
      text: latestUser.trim(),
      isLatestUser: true,
    });
  } else {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user") {
        turns[i] = { ...turns[i], isLatestUser: true };
        break;
      }
    }
  }

  if (turns.length === 0) {
    const empty = new Float32Array(384);
    return {
      vector: empty,
      summary: "(empty)",
      turns: [],
      anchorText: "",
    };
  }

  const n = turns.length;
  const texts = turns.map((t) => t.text);
  const vectors = await embedMany(texts, backend);

  const anchorIdx = turns.findIndex((t) => t.isLatestUser);
  const anchorIndex = anchorIdx >= 0 ? anchorIdx : n - 1;
  const anchorVec = vectors[anchorIndex];
  const anchorText = turns[anchorIndex].text;

  const details: QueryTurnDetail[] = [];
  const includedVectors: Float32Array[] = [];
  const includedWeights: number[] = [];

  for (let i = 0; i < n; i++) {
    const age = n - 1 - i;
    let baseWeight = Math.exp(-QUERY_DECAY_LAMBDA * age);
    if (turns[i].isLatestUser) baseWeight *= QUERY_USER_BOOST;

    const anchorSimilarity = cosine(vectors[i], anchorVec);
    const isAnchor = i === anchorIndex;
    const included =
      isAnchor || anchorSimilarity >= QUERY_MIN_ANCHOR_SIM;
    const finalWeight = included ? baseWeight : 0;

    details.push({
      role: turns[i].role,
      text: turns[i].text,
      age,
      baseWeight,
      finalWeight,
      anchorSimilarity,
      included,
    });

    if (included) {
      includedVectors.push(vectors[i]);
      includedWeights.push(finalWeight);
    }
  }

  const vector = weightedAverage(includedVectors, includedWeights);

  const includedCount = details.filter((d) => d.included).length;
  const summary = [
    `anchor: ${anchorText.slice(0, 48)}${anchorText.length > 48 ? "…" : ""}`,
    `turns: ${includedCount}/${n} (λ=${QUERY_DECAY_LAMBDA}, minSim=${QUERY_MIN_ANCHOR_SIM})`,
  ].join(" · ");

  return { vector, summary, turns: details, anchorText };
}
