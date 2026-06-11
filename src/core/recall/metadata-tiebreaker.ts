/**
 * Metadata tiebreaker (NLM #308, Arm 1).
 *
 * Applies a small multiplicative score bonus to keyword hits whose extracted
 * decision text (and, secondarily, entity canonicals) overlaps the query
 * tokens. Designed to reorder near-ties only: the bonus is capped at
 * +DEC_BONUS_CAP+ENT_BONUS_CAP (≈15% of the hit's own score), so it can lift
 * a session past a marginally-higher BM25 neighbour but never past a hit that
 * scores meaningfully higher.
 *
 * Why decision overlap dominates: on the decision-recall corpus the gold
 * session for a "what did we decide about X" query reliably has high
 * decision-token overlap (8-12 tokens) while the BM25 neighbours that edge it
 * out have zero — the decision markers are the discriminating signal that
 * BM25's label/summary weighting misses. Entity overlap is near-constant
 * across the candidate set and contributes a weak secondary nudge.
 *
 * The bonus scales with the *fraction* of query tokens matched (not raw
 * count) so it is comparable across queries of different length, and is
 * applied multiplicatively so a strong BM25 hit with the same overlap keeps
 * its lead. Pure function: same DB-resolved hit fields in, same factor out.
 */

import { tokenSet } from "./tokenize.js";

// Caps chosen from the #308 near-miss distribution: the gold sessions that
// needed rescuing sat 1-14.5% below the rank-5 BM25 score. A combined cap of
// 0.15 (multiplicative band 1.00-1.15) covers the recoverable near-ties
// without being able to invert a genuinely stronger match. Decisions carry
// the bulk (0.13); entities a thin tiebreak-of-the-tiebreak (0.02).
const DEC_BONUS_CAP = 0.13;
const ENT_BONUS_CAP = 0.02;

interface TiebreakInput {
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
}

/**
 * Fraction of query tokens that appear in the tokenized join of the given
 * text fields. 0 when there are no query tokens or no field text.
 */
function overlapFraction(queryTokens: ReadonlySet<string>, fields: ReadonlyArray<string>): number {
  if (queryTokens.size === 0) return 0;
  const fieldTokens = new Set<string>();
  for (const f of fields) for (const t of tokenSet(f)) fieldTokens.add(t);
  if (fieldTokens.size === 0) return 0;
  let matched = 0;
  for (const t of queryTokens) if (fieldTokens.has(t)) matched++;
  return matched / queryTokens.size;
}

/**
 * Multiplicative bonus factor in [1, 1 + DEC_BONUS_CAP + ENT_BONUS_CAP].
 * Multiply the hit's matchScore by this before re-sorting.
 */
export function tiebreakFactor(queryTokens: ReadonlySet<string>, hit: TiebreakInput): number {
  const decFraction = overlapFraction(queryTokens, hit.decisions);
  const entFraction = overlapFraction(queryTokens, hit.entities);
  return 1 + DEC_BONUS_CAP * decFraction + ENT_BONUS_CAP * entFraction;
}
