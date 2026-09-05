/**
 * Conversation pattern chunks: key = context that should fire,
 * value = next utterance. Chaining happens by appending values
 * and re-querying the KV store — no token generation.
 *
 * G7a: claims are authored as YAML under `corpus/claims/*.yml` and compiled to
 * `corpus.generated.ts` via `npm run corpus:build`. Languages may be omitted;
 * only present surfaces are indexed.
 *
 * Each surface has TWO keys when authored fully:
 *   - `nat`: natural-sentence trigger (bi-encoder RANKING)
 *   - `key`: keyword-bag (cross-encoder CONFIDENCE-GATE); auto-derived if omitted
 */

import type { ChunkRecord, Lang } from "./types";
import type { AuthorClaim, AuthorSurface } from "./corpus-author";
import { GENERATED_CLAIMS } from "./corpus.generated.ts";

function assertionsOf(surface: AuthorSurface): string[] | undefined {
  if (!surface.assertion) return undefined;
  return Array.isArray(surface.assertion)
    ? surface.assertion
    : [surface.assertion];
}

/** Fold closed sameIntent paraphrases into the ranking / gate keys (S2). */
export function thickenNatKey(nat: string, sameIntent?: string[]): string {
  if (!sameIntent?.length) return nat;
  const parts = [nat];
  const seen = new Set([nat.trim()]);
  for (const p of sameIntent) {
    const t = p.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    parts.push(t);
  }
  return parts.join(" ");
}

function chunkFromSurface(
  claim: AuthorClaim,
  lang: Lang,
  surface: AuthorSurface,
): ChunkRecord {
  // sameIntent expands ranking keys only — never the CE gate keyword bag
  // (thickening `key` collapsed fuse bipartite matching in S2 pilots).
  const natKey = thickenNatKey(surface.nat, surface.sameIntent);
  return {
    id: `${claim.claim}-${lang}`,
    claim: claim.claim,
    lang,
    key: surface.key ?? surface.nat,
    natKey,
    value: surface.value,
    spans: surface.spans?.map((s) => ({
      id: s.id,
      text: s.text,
      tags: s.tags,
      nliHypothesis: s.nliHypothesis,
    })),
    speaker: claim.speaker,
    assertions: assertionsOf(surface),
    stance: claim.stance,
    tags: claim.tags ?? [],
    qud: claim.qud,
    detailClaim: claim.detailClaim,
    edges: claim.edges,
  };
}

/** Flatten author claims → engine index rows (one per present language). */
export function flattenClaims(claims: AuthorClaim[]): ChunkRecord[] {
  const out: ChunkRecord[] = [];
  for (const c of claims) {
    if (c.ja) out.push(chunkFromSurface(c, "ja", c.ja));
    if (c.en) out.push(chunkFromSurface(c, "en", c.en));
    if (c.zh) out.push(chunkFromSurface(c, "zh", c.zh));
  }
  return out;
}

export const CHUNK_CORPUS: ChunkRecord[] = flattenClaims(GENERATED_CLAIMS);

/** Author-level claim list (for tooling / G7). */
export const CORPUS_CLAIMS: AuthorClaim[] = GENERATED_CLAIMS;
