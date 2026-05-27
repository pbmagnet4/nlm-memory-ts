/**
 * Query shape detection for force-include of keyword rank-1 in hybrid recall.
 *
 * Build F (2026-05-26): when a query has both a temporal marker and a
 * named-entity-shaped token, the keyword-leg rank-1 session is force-included
 * in the merged top-k result. Diagnostic justification: of 7 hybrid temporal
 * misses where keyword found the right session, 5 had keyword rank=1 and
 * pure RRF demoted them out of top-5 because the same session wasn't in
 * semantic's top-15. Build E′ (asymmetric multiplicative boost) contributed
 * zero — boost magnitude was too small to overcome the "appears in both lists
 * at lower rank" advantage. Force-include sidesteps RRF math entirely.
 *
 * Probe data (n=500 LongMemEval-S, hybrid k=5):
 *   - 17.3% of temporal-reasoning queries match the shape
 *   - 0% of single-session-preference, 0% of single-session-assistant
 *   - 1.4-2.6% of other types — bounded blast radius
 */
export interface QueryShape {
    readonly hasTemporal: boolean;
    readonly hasNamedEntity: boolean;
}
export declare function detectQueryShape(query: string): QueryShape;
