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
import type { ClassifyResult } from "../../ports/llm-client.js";
import type { Fact } from "../../shared/types.js";
export interface ExtractFactsOptions {
    /** Generator for fact ids. Defaults to `fact_<randomUUID()>`. */
    readonly idGenerator?: () => string;
}
export declare function extractFacts(result: ClassifyResult, sessionId: string, createdAt: string, opts?: ExtractFactsOptions): Fact[];
