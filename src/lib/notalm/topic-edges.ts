/**
 * S3 — static RST-ish claim edges (informational only).
 * Does not replace attentional state / anaphora (S1 boundary).
 * Dialogue edges (follow-up / QAP) are deferred to S4 (Moore & Pollack).
 */

export const STATIC_EDGE_RELS = ["elaborates", "contrasts", "parallel"] as const;

export type StaticEdgeRel = (typeof STATIC_EDGE_RELS)[number];

export type AuthorEdge = {
  rel: StaticEdgeRel;
  /** Target claim id */
  to: string;
};

export type ResolvedEdge = {
  rel: StaticEdgeRel;
  from: string;
  to: string;
};

/** Soft CE bonus when fuse pairs claims linked by a static edge. */
export const EDGE_FUSE_PAIR_BONUS = 0.08;

/** Soft retrieval boost for edge-neighbors of the continuity claim. */
export const EDGE_RETRIEVAL_BONUS = 0.04;

export function isStaticEdgeRel(v: unknown): v is StaticEdgeRel {
  return (
    typeof v === "string" &&
    (STATIC_EDGE_RELS as readonly string[]).includes(v)
  );
}

/** Normalize authored edges (trim, drop self/invalid). */
export function cleanAuthorEdges(
  edges: AuthorEdge[] | undefined,
  fromClaim: string,
): AuthorEdge[] | undefined {
  if (!edges?.length) return undefined;
  const out: AuthorEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!isStaticEdgeRel(e?.rel)) continue;
    const to = e.to?.trim();
    if (!to || to === fromClaim) continue;
    const key = `${e.rel}→${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rel: e.rel, to });
  }
  return out.length ? out : undefined;
}

/**
 * Nuclearity role for an endpoint of a directed edge record.
 * elaborates: from=nucleus, to=satellite.
 * contrasts / parallel: both multinuclear.
 */
export function nuclearityRole(
  rel: StaticEdgeRel,
  endpoint: "from" | "to",
): "nucleus" | "satellite" | "multi" {
  if (rel === "elaborates") {
    return endpoint === "from" ? "nucleus" : "satellite";
  }
  return "multi";
}

/** Undirected lookup key for parallel / contrasts. */
function undirectedKey(a: string, b: string): string {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

export type ClaimEdgeIndex = {
  /** All resolved directed edges (elaborates as authored; multi-rels mirrored). */
  edges: ResolvedEdge[];
  /** claim → outgoing + incoming resolved edges */
  byClaim: Map<string, ResolvedEdge[]>;
  /** undirected multi-rel pairs */
  multiPairs: Map<string, StaticEdgeRel>;
  /** elaborates: nucleus → satellites */
  elaboratesFrom: Map<string, string[]>;
  /** elaborates: satellite → nuclei */
  elaboratesTo: Map<string, string[]>;
};

export function buildClaimEdgeIndex(
  claims: Iterable<{ claim: string; edges?: AuthorEdge[] }>,
): ClaimEdgeIndex {
  const edges: ResolvedEdge[] = [];
  const byClaim = new Map<string, ResolvedEdge[]>();
  const multiPairs = new Map<string, StaticEdgeRel>();
  const elaboratesFrom = new Map<string, string[]>();
  const elaboratesTo = new Map<string, string[]>();

  const pushBy = (id: string, edge: ResolvedEdge) => {
    const list = byClaim.get(id);
    if (list) list.push(edge);
    else byClaim.set(id, [edge]);
  };

  for (const c of claims) {
    const from = c.claim?.trim();
    if (!from || !c.edges?.length) continue;
    for (const e of cleanAuthorEdges(c.edges, from) ?? []) {
      const directed: ResolvedEdge = { rel: e.rel, from, to: e.to };
      edges.push(directed);
      pushBy(from, directed);
      pushBy(e.to, directed);

      if (e.rel === "elaborates") {
        const outs = elaboratesFrom.get(from) ?? [];
        if (!outs.includes(e.to)) {
          outs.push(e.to);
          elaboratesFrom.set(from, outs);
        }
        const inns = elaboratesTo.get(e.to) ?? [];
        if (!inns.includes(from)) {
          inns.push(from);
          elaboratesTo.set(e.to, inns);
        }
      } else {
        multiPairs.set(undirectedKey(from, e.to), e.rel);
        // Mirror for symmetric lookup in byClaim consumers
        const mirror: ResolvedEdge = { rel: e.rel, from: e.to, to: from };
        edges.push(mirror);
        pushBy(e.to, mirror);
        pushBy(from, mirror);
      }
    }
  }

  return { edges, byClaim, multiPairs, elaboratesFrom, elaboratesTo };
}

/** Relation linking two claims, if any (prefers elaborates, then contrasts, then parallel). */
export function relationBetween(
  index: ClaimEdgeIndex,
  a?: string,
  b?: string,
): StaticEdgeRel | undefined {
  if (!a || !b || a === b) return undefined;
  const outs = index.elaboratesFrom.get(a);
  if (outs?.includes(b)) return "elaborates";
  const outsB = index.elaboratesFrom.get(b);
  if (outsB?.includes(a)) return "elaborates";
  return index.multiPairs.get(undirectedKey(a, b));
}

export function fusePairBonus(
  index: ClaimEdgeIndex,
  claimA?: string,
  claimB?: string,
): number {
  return relationBetween(index, claimA, claimB) ? EDGE_FUSE_PAIR_BONUS : 0;
}

export function retrievalEdgeBonus(
  index: ClaimEdgeIndex,
  continuityClaim: string | undefined,
  candidateClaim: string | undefined,
): number {
  if (!continuityClaim || !candidateClaim) return 0;
  if (continuityClaim === candidateClaim) return 0;
  return relationBetween(index, continuityClaim, candidateClaim)
    ? EDGE_RETRIEVAL_BONUS
    : 0;
}

/**
 * Reorder fuse parts so elaborates nucleus is first (full compose).
 * Multinuclear pairs keep input order.
 */
export function orderPartsByNuclearity<
  T extends { chunk: { claim?: string } },
>(parts: T[], index: ClaimEdgeIndex): { parts: T[]; notes: string[] } {
  if (parts.length < 2) return { parts, notes: [] };
  const notes: string[] = [];
  const claims = parts.map((p) => p.chunk.claim?.trim() || "");
  for (let i = 0; i < claims.length; i++) {
    for (let j = 0; j < claims.length; j++) {
      if (i === j) continue;
      const a = claims[i];
      const b = claims[j];
      if (!a || !b) continue;
      const outs = index.elaboratesFrom.get(a);
      if (outs?.includes(b) && i > j) {
        // nucleus currently after satellite → swap into nucleus-first
        const next = parts.slice();
        const tmp = next[j];
        next[j] = next[i];
        next[i] = tmp;
        notes.push(`s3:nuclearity-reorder:${a}→${b}`);
        return { parts: next, notes };
      }
    }
  }
  const rel = relationBetween(index, claims[0], claims[1]);
  if (rel) notes.push(`s3:edge:${rel}:${claims[0]}↔${claims[1]}`);
  return { parts, notes };
}

/** First elaborates satellite for a nucleus (detailClaim sugar fallback). */
export function elaboratesSatellite(
  index: ClaimEdgeIndex,
  nucleusClaim: string | undefined,
): string | undefined {
  if (!nucleusClaim) return undefined;
  return index.elaboratesFrom.get(nucleusClaim)?.[0];
}
