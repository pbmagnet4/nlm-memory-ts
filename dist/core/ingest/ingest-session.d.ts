/**
 * ingestSession — push a single externally-supplied session through the
 * normal classifier → embedder → store pipeline.
 *
 * Shared by the webhook endpoint (POST /api/ingest) and anything else
 * that wants to push without going through a TranscriptAdapter. Mirrors
 * the inner loop of ScanScheduler.runOnce but accepts a pre-built chunk.
 */
import type { SqliteFactStore } from "../storage/sqlite-fact-store.js";
import type { SqliteSessionStore } from "../storage/sqlite-session-store.js";
import type { LLMClient } from "../../ports/llm-client.js";
export interface IngestInput {
    /** Optional — if omitted, derived from a hash of (runtime + startedAt + text). */
    readonly id?: string;
    readonly runtime: string;
    readonly runtimeSessionId?: string | null;
    readonly text: string;
    readonly startedAt?: string;
    readonly endedAt?: string | null;
    readonly transcriptPath?: string | null;
    /** Webhook id when the source is webhook-pushed; null for generic. */
    readonly sourceId?: number | null;
}
export interface IngestDeps {
    readonly classifier: LLMClient;
    readonly embedder: LLMClient;
    readonly store: SqliteSessionStore;
    readonly factStore?: SqliteFactStore;
    /** Optional logger — defaults to console.error. */
    readonly log?: (msg: string) => void;
}
export interface IngestResult {
    readonly id: string;
    readonly status: "ingested" | "low_confidence" | "classifier_failed";
    readonly latencyMs: number;
    readonly confidence?: number;
    readonly error?: string;
}
export declare function deriveSessionId(runtime: string, startedAt: string, text: string): string;
export declare function ingestSession(input: IngestInput, deps: IngestDeps): Promise<IngestResult>;
