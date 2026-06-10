/**
 * Selects which recall hits the hook surfaces. Pure — no I/O.
 *
 * Order of filtering: score threshold, then dedup against ids already
 * surfaced in this conversation, then the per-fire cap bounded by the
 * remaining per-conversation budget. Hits are assumed pre-ranked best-first.
 */

export interface RecallHitInput {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
  readonly matchScore: number;
  readonly summary?: string;
}

export interface SelectParams {
  readonly hits: ReadonlyArray<RecallHitInput>;
  readonly surfaced: ReadonlySet<string>;
  readonly scoreThreshold: number;
  readonly perFireCap: number;
  readonly perConversationCap: number;
}

export function selectHits(params: SelectParams): ReadonlyArray<RecallHitInput> {
  const { hits, surfaced, scoreThreshold, perFireCap, perConversationCap } = params;
  const eligible = hits.filter(
    (h) => h.matchScore >= scoreThreshold && !surfaced.has(h.id),
  );
  const budget = Math.max(0, perConversationCap - surfaced.size);
  const limit = Math.min(perFireCap, budget);
  return eligible.slice(0, limit);
}
