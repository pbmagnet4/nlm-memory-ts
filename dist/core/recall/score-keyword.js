/**
 * Keyword scoring for a single session against query tokens.
 *
 * Field weights mirror recall.py:_WEIGHTS. The scorer is a pure function over
 * {session, query tokens} — no DB, no embedder, no I/O. This is the layer the
 * tests pin to byte-for-byte parity with the Python implementation.
 */
import { tokenSet } from "./tokenize.js";
const FIELD_WEIGHTS = {
    label: 3,
    decisions: 2,
    open: 2,
    summary: 1,
};
const EMPTY_SCORE = { score: 0, matchedIn: [] };
export function scoreKeyword(session, queryTokens) {
    if (queryTokens.size === 0)
        return EMPTY_SCORE;
    let score = 0;
    const matchedIn = [];
    const labelMatches = intersectionSize(queryTokens, tokenSet(session.label));
    if (labelMatches > 0) {
        score += FIELD_WEIGHTS.label * labelMatches;
        matchedIn.push("label");
    }
    const decisionTokens = new Set();
    for (const d of session.decisions) {
        for (const t of tokenSet(d))
            decisionTokens.add(t);
    }
    const decisionMatches = intersectionSize(queryTokens, decisionTokens);
    if (decisionMatches > 0) {
        score += FIELD_WEIGHTS.decisions * decisionMatches;
        matchedIn.push("decisions");
    }
    const openTokens = new Set();
    for (const o of session.open) {
        for (const t of tokenSet(o))
            openTokens.add(t);
    }
    const openMatches = intersectionSize(queryTokens, openTokens);
    if (openMatches > 0) {
        score += FIELD_WEIGHTS.open * openMatches;
        matchedIn.push("open");
    }
    const summaryMatches = intersectionSize(queryTokens, tokenSet(session.summary));
    if (summaryMatches > 0) {
        score += FIELD_WEIGHTS.summary * summaryMatches;
        matchedIn.push("summary");
    }
    return { score, matchedIn };
}
function intersectionSize(a, b) {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let count = 0;
    for (const item of small)
        if (large.has(item))
            count += 1;
    return count;
}
//# sourceMappingURL=score-keyword.js.map