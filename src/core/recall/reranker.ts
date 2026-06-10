// Citation frequency is a proxy for recalled value; log-scaling prevents
// runaway dominance while preserving baseline ranking, and zero-score results
// are never promoted above non-zero hits.

import type { CitationEntry } from "./citation-log.js";

export type CitationBoostMap = Map<string, number>;

const ALPHA = 0.15;

export function buildCitationBoosts(
  citations: ReadonlyArray<CitationEntry>,
): CitationBoostMap {
  const counts = new Map<string, number>();
  for (const c of citations) {
    counts.set(c.citedId, (counts.get(c.citedId) ?? 0) + 1);
  }

  const boosts: CitationBoostMap = new Map();
  for (const [id, count] of counts) {
    boosts.set(id, ALPHA * Math.log(1 + count));
  }

  return boosts;
}

// Zero-score results never promoted above non-zero hits — preserves the
// invariant that non-matches stay below matches.
export function applyBoosts<T extends { id: string; matchScore: number }>(
  results: ReadonlyArray<T>,
  boosts: CitationBoostMap,
): T[] {
  if (boosts.size === 0) return [...results];

  const boosted = results.map((r) => {
    if (r.matchScore === 0) return r;
    const boost = boosts.get(r.id) ?? 0;
    return { ...r, matchScore: r.matchScore + boost };
  });

  return boosted.sort((a, b) => b.matchScore - a.matchScore);
}
