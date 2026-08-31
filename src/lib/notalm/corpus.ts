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

function chunkFromSurface(
  claim: AuthorClaim,
  lang: Lang,
  surface: AuthorSurface,
): ChunkRecord {
  return {
    id: `${claim.claim}-${lang}`,
    claim: claim.claim,
    lang,
    key: surface.key ?? surface.nat,
    natKey: surface.nat,
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
