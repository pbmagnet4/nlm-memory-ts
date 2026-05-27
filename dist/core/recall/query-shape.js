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
const TEMPORAL_PATTERNS = [
    /\b\d+\s+(day|week|month|year)s?\s+ago\b/i,
    /\b(last|past|next)\s+(week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\bwhen\s+did\b/i,
    /\b(before|after)\s+I\b/,
    /\bago\b/i,
    /\b(yesterday|today|tomorrow)\b/i,
    /\bhow\s+(long|many)\s+(days?|weeks?|months?|years?)\s+ago\b/i,
];
const COMMON_CAPS_NON_NE = new Set([
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
    "i", "i'd", "i've", "i'm", "i'll",
]);
export function detectQueryShape(query) {
    if (!query)
        return { hasTemporal: false, hasNamedEntity: false };
    const hasTemporal = TEMPORAL_PATTERNS.some((re) => re.test(query));
    const hasNamedEntity = detectNamedEntity(query);
    return { hasTemporal, hasNamedEntity };
}
function detectNamedEntity(query) {
    const tokens = query.split(/[\s,.;:!?()"'`]+/).filter((t) => t.length > 0);
    if (tokens.length === 0)
        return false;
    for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok && isNamedEntityToken(tok))
            return true;
    }
    return false;
}
function isNamedEntityToken(tok) {
    if (COMMON_CAPS_NON_NE.has(tok.toLowerCase()))
        return false;
    if (tok.length < 2)
        return false;
    if (/^[A-Z]{2,}$/.test(tok))
        return true;
    const hasUpper = /[A-Z]/.test(tok);
    const hasLower = /[a-z]/.test(tok);
    if (hasUpper && hasLower)
        return true;
    return false;
}
//# sourceMappingURL=query-shape.js.map