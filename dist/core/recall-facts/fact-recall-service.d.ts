/**
 * FactRecallService — agent-facing recall over the FactStore.
 *
 * Mirrors RecallService's keyword / semantic / hybrid pattern but works on
 * Fact records, not Session records. Sessions and facts answer different
 * questions and have incompatibly-shaped results, so this is a separate
 * service with its own MCP tool — see Section 4 of factstore-design.md.
 *
 * Filter pipeline:
 *   1. Storage pre-filter (subject, predicate, kind, minConfidence,
 *      includeSuperseded). Cheap SQL.
 *   2. Keyword scoring over (value, subject, predicate). Pure, in-memory.
 *   3. Semantic KNN via fact_embeddings vec0 (when mode != keyword).
 *   4. Hybrid merge: 0.6 semantic + 0.4 keyword, matching the session
 *      recall weights.
 *
 * Confidence policy: default `minConfidence` is 0.6 (Section 1 of the plan).
 * Facts with classifier confidence in [0.4, 0.6) get written by
 * extractFacts but stay out of agent recall unless the caller lowers the
 * floor explicitly.
 */
import type { FactStore } from "../../ports/fact-store.js";
import type { LLMClient } from "../../ports/llm-client.js";
import type { FactRecallQuery, FactRecallResult } from "../../shared/types.js";
export interface FactRecallServiceDeps {
    readonly factStore: FactStore;
    readonly llm: LLMClient;
}
export declare class FactRecallService {
    private readonly deps;
    constructor(deps: FactRecallServiceDeps);
    search(input: FactRecallQuery): Promise<FactRecallResult>;
    private runSemantic;
}
