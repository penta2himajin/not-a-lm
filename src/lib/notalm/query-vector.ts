import { cosine, embed, embedMany, type EmbedBackend } from "./embed";
import type { ChatMessage, Speaker } from "./types";

/** Max dialogue pairs (user+bot units) in query window */
export const QUERY_MAX_PAIRS = 4;

/** exp(-λ * age): higher λ → faster decay of older pairs */
export const QUERY_DECAY_LAMBDA = 0.55;

/** Extra multiplier on the anchor (newest) pair */
export const QUERY_ANCHOR_BOOST = 2.5;

/** Pair must be this similar to anchor to enter the cluster (anchor always kept) */
export const QUERY_PAIR_ANCHOR_MIN = 0.25;

/** Adjacent pairs must exceed this to stay in the same local topic chain */
export const QUERY_PAIR_CHAIN_MIN = 0.32;

/** Blend user vs bot when building a pair embedding (keys are user-trigger-like) */
export const PAIR_USER_WEIGHT = 0.78;
export const PAIR_BOT_WEIGHT = 0.22;

export type QueryTurnDetail = {
  role: Speaker;
  text: string;
  age: number;
  baseWeight: number;
  finalWeight: number;
  anchorSimilarity: number;
  included: boolean;
  pairIndex?: number;
};

export type QueryPairDetail = {
  index: number;
  userText: string;
  botText?: string;
  anchorSimilarity: number;
  chainSimilarity?: number;
  included: boolean;
  finalWeight: number;
};

export type ComposedQuery = {
  vector: Float32Array;
  summary: string;
  turns: QueryTurnDetail[];
  pairs: QueryPairDetail[];
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

function blendVectors(a: Float32Array, b: Float32Array, wa: number, wb: number): Float32Array {
  const dim = a.length;
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = a[i] * wa + b[i] * wb;
  return l2Normalize(out);
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

type RawPair = {
  userText: string;
  botText?: string;
  isAnchor: boolean;
};

/** Group flat messages into user→bot dialogue pairs (chronological). */
function buildDialoguePairs(
  history: ChatMessage[],
  latestUser: string | undefined,
): RawPair[] {
  const pairs: RawPair[] = [];
  const recent = history.slice(-(QUERY_MAX_PAIRS * 2));

  let pendingUser: string | null = null;
  for (const m of recent) {
    if (m.role === "user") {
      if (pendingUser !== null) {
        pairs.push({ userText: pendingUser, isAnchor: false });
      }
      pendingUser = m.text;
    } else if (m.role === "bot" && pendingUser !== null) {
      pairs.push({ userText: pendingUser, botText: m.text, isAnchor: false });
      pendingUser = null;
    }
  }

  if (latestUser?.trim()) {
    if (pendingUser !== null) {
      pairs.push({ userText: pendingUser, isAnchor: false });
    }
    pairs.push({ userText: latestUser.trim(), isAnchor: true });
  } else if (pendingUser !== null) {
    pairs.push({ userText: pendingUser, isAnchor: true });
  } else if (pairs.length > 0) {
    pairs[pairs.length - 1] = {
      ...pairs[pairs.length - 1],
      isAnchor: true,
    };
  }

  return pairs.slice(-QUERY_MAX_PAIRS);
}

async function embedPair(
  pair: RawPair,
  backend: EmbedBackend,
  userVec?: Float32Array,
  botVec?: Float32Array,
): Promise<Float32Array> {
  if (!botVec) {
    if (userVec) return userVec;
    return embed(pair.userText, backend);
  }
  const u = userVec ?? (await embed(pair.userText, backend));
  const b = botVec ?? (await embed(pair.botText!, backend));
  return blendVectors(u, b, PAIR_USER_WEIGHT, PAIR_BOT_WEIGHT);
}

/**
 * Local topic cluster on dialogue pairs:
 * 1. Embed each (user, bot?) pair
 * 2. Walk backward from anchor while chain + anchor similarity hold
 * 3. Oldest→newest exponential weighted average of pair vectors
 *
 * Cosine on L2-normalized bekko vectors ≡ dot product; standard for retrieval.
 */
export async function composeQueryVector(
  history: ChatMessage[],
  latestUser: string | undefined,
  backend: EmbedBackend,
): Promise<ComposedQuery> {
  const pairs = buildDialoguePairs(history, latestUser);

  if (pairs.length === 0) {
    return {
      vector: new Float32Array(384),
      summary: "(empty)",
      turns: [],
      pairs: [],
      anchorText: "",
    };
  }

  const userTexts = pairs.map((p) => p.userText);
  const userVecs = await embedMany(userTexts, backend);

  const botIndices: number[] = [];
  const botTexts: string[] = [];
  pairs.forEach((p, i) => {
    if (p.botText) {
      botIndices.push(i);
      botTexts.push(p.botText);
    }
  });
  const botVecs =
    botTexts.length > 0 ? await embedMany(botTexts, backend) : [];
  const botVecByPair = new Map<number, Float32Array>();
  botIndices.forEach((pairIdx, j) => {
    botVecByPair.set(pairIdx, botVecs[j]);
  });

  const pairVecs: Float32Array[] = [];
  for (let i = 0; i < pairs.length; i++) {
    pairVecs.push(
      await embedPair(
        pairs[i],
        backend,
        userVecs[i],
        botVecByPair.get(i),
      ),
    );
  }

  const anchorIdx = pairs.findIndex((p) => p.isAnchor);
  const anchorIndex = anchorIdx >= 0 ? anchorIdx : pairs.length - 1;
  const anchorVec = pairVecs[anchorIndex];
  const anchorText = pairs[anchorIndex].userText;

  const anchorSims = pairVecs.map((v) => cosine(v, anchorVec));
  const chainSims: (number | undefined)[] = pairs.map((_, i) =>
    i < pairs.length - 1 ? cosine(pairVecs[i], pairVecs[i + 1]) : undefined,
  );

  const included = new Array<boolean>(pairs.length).fill(false);
  included[anchorIndex] = true;

  for (let i = anchorIndex - 1; i >= 0; i--) {
    const chainOk = (chainSims[i] ?? 0) >= QUERY_PAIR_CHAIN_MIN;
    const anchorOk = anchorSims[i] >= QUERY_PAIR_ANCHOR_MIN;
    if (chainOk && anchorOk) {
      included[i] = true;
    } else {
      break;
    }
  }

  const pairDetails: QueryPairDetail[] = [];
  const turnDetails: QueryTurnDetail[] = [];
  const includedVectors: Float32Array[] = [];
  const includedWeights: number[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const age = pairs.length - 1 - i;
    let baseWeight = Math.exp(-QUERY_DECAY_LAMBDA * age);
    if (i === anchorIndex) baseWeight *= QUERY_ANCHOR_BOOST;
    const finalWeight = included[i] ? baseWeight : 0;

    pairDetails.push({
      index: i,
      userText: pairs[i].userText,
      botText: pairs[i].botText,
      anchorSimilarity: anchorSims[i],
      chainSimilarity: chainSims[i],
      included: included[i],
      finalWeight,
    });

    if (included[i]) {
      includedVectors.push(pairVecs[i]);
      includedWeights.push(finalWeight);
    }

    const turnWeightUser = finalWeight;
    const turnWeightBot = pairs[i].botText ? finalWeight * PAIR_BOT_WEIGHT : 0;

    turnDetails.push({
      role: "user",
      text: pairs[i].userText,
      age,
      baseWeight,
      finalWeight: turnWeightUser,
      anchorSimilarity: anchorSims[i],
      included: included[i],
      pairIndex: i,
    });
    if (pairs[i].botText) {
      turnDetails.push({
        role: "bot",
        text: pairs[i].botText,
        age,
        baseWeight,
        finalWeight: included[i] ? turnWeightBot : 0,
        anchorSimilarity: anchorSims[i],
        included: included[i],
        pairIndex: i,
      });
    }
  }

  const vector = weightedAverage(includedVectors, includedWeights);
  const includedPairCount = included.filter(Boolean).length;

  const summary = [
    `anchor: ${anchorText.slice(0, 40)}${anchorText.length > 40 ? "…" : ""}`,
    `pairs: ${includedPairCount}/${pairs.length} (anchor≥${QUERY_PAIR_ANCHOR_MIN}, chain≥${QUERY_PAIR_CHAIN_MIN})`,
  ].join(" · ");

  return {
    vector,
    summary,
    turns: turnDetails,
    pairs: pairDetails,
    anchorText,
  };
}
