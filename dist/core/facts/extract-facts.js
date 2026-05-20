/**
 * extractFacts — pure transform from ClassifyResult to Fact[].
 *
 * Lives in core/, has no framework imports, no clock or randomness coupling
 * (id generator and timestamp are injected so tests are deterministic).
 * Phase B.2 — see docs/plans/factstore-design.md Section 3.
 *
 * Confidence policy (Section 3 of the plan): facts inherit the session-level
 * confidence verbatim. Below 0.4 the function returns an empty array — the
 * session still ingests with markers, but its facts are dropped as
 * extraction-quality noise. Between 0.4 and 0.6 facts are written but will
 * be filtered out of recall by the FactStore default `minConfidence: 0.6`.
 */
import { randomUUID } from "node:crypto";
const CONFIDENCE_FLOOR = 0.4;
export function extractFacts(result, sessionId, createdAt, opts = {}) {
    if (result.confidence < CONFIDENCE_FLOOR)
        return [];
    const genId = opts.idGenerator ?? (() => `fact_${randomUUID()}`);
    const out = [];
    for (const raw of result.facts) {
        out.push({
            id: genId(),
            kind: raw.kind,
            subject: raw.subject,
            predicate: raw.predicate,
            value: raw.value,
            sourceSessionId: sessionId,
            sourceQuote: raw.sourceQuote ?? null,
            createdAt,
            supersededBy: null,
            confidence: result.confidence,
        });
    }
    return out;
}
//# sourceMappingURL=extract-facts.js.map