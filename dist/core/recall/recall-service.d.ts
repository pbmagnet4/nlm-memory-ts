/**
 * RecallService — the use case. Composes filters, keyword scoring, and
 * semantic search into a single recall operation.
 *
 * Depends only on ports (SessionStore, LLMClient). No framework imports,
 * no SQLite, no HTTP. Tests substitute fake adapters.
 */
import type { LLMClient } from "../../ports/llm-client.js";
import type { SessionStore } from "../../ports/session-store.js";
import type { RecallQuery, RecallResult } from "../../shared/types.js";
export interface RecallServiceDeps {
    readonly store: SessionStore;
    readonly llm: LLMClient;
}
export declare class RecallService {
    private readonly deps;
    constructor(deps: RecallServiceDeps);
    search(input: RecallQuery): Promise<RecallResult>;
}
