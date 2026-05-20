/**
 * backfill-facts — one-shot population of the FactStore from the existing
 * session corpus. Phase B.5, see docs/plans/factstore-design.md Section 7.
 *
 * For each session in `sessions` that has no facts yet (and was started
 * before the script's start timestamp, to avoid racing with live ingest),
 * runs the classifier over its body, extracts facts, and writes them via
 * SqliteSessionStore.insertFactsForSession.
 *
 * Resumable via a JSON state file (mirrors core/embedding/embed-backfill).
 * Interrupting and rerunning skips already-processed sessions. State path
 * defaults to ~/.nlm/backfill_facts.state.
 *
 * Layering: depends on the LLMClient + FactStore ports through the
 * SqliteSessionStore + SqliteFactStore composition. Lives under core/ but
 * is invoked from the CLI composition root, like embed-backfill.
 */
import type { SqliteFactStore } from "../storage/sqlite-fact-store.js";
import type { SqliteSessionStore } from "../storage/sqlite-session-store.js";
import type { LLMClient } from "../../ports/llm-client.js";
export interface BackfillFactsOptions {
    readonly store: SqliteSessionStore;
    readonly factStore: SqliteFactStore;
    readonly classifier: LLMClient;
    /** Optional embedder. When omitted, facts are written without semantic vectors. */
    readonly embedder?: LLMClient | null;
    readonly statePath?: string;
    /** Cap on sessions processed this run. Default: all eligible. */
    readonly limit?: number;
    /**
     * Resume from a specific session id. When set, sessions with id
     * lexicographically <= this value are skipped on top of the state file's
     * done set. Useful when the state file is lost but the operator
     * remembers the last successful id.
     */
    readonly from?: string;
    /** Don't write — just count what would happen. */
    readonly dryRun?: boolean;
    /**
     * Re-process sessions that already have facts. Default: false (skip).
     * Use when iterating the classifier prompt to refresh the corpus.
     */
    readonly reprocess?: boolean;
    readonly onProgress?: (i: number, total: number, sessionId: string, status: BackfillStatus, details?: string) => void;
}
export type BackfillStatus = "ok" | "skipped_done" | "skipped_existing_facts" | "skipped_no_body" | "skipped_low_confidence" | "classify_failed" | "storage_failed";
export interface BackfillFactsReport {
    readonly total: number;
    readonly processed: number;
    readonly factsWritten: number;
    readonly skippedAlreadyDone: number;
    readonly skippedExistingFacts: number;
    readonly skippedNoBody: number;
    readonly skippedLowConfidence: number;
    readonly classifyFailures: number;
    readonly storageFailures: number;
}
export declare function backfillFacts(opts: BackfillFactsOptions): Promise<BackfillFactsReport>;
