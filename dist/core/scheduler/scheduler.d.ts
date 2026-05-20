/**
 * ScanScheduler — periodic ingest loop. Ports `scheduler.py`.
 *
 * Each tick walks the registered adapters, runs scanOnce to discover idle
 * transcript files, classifies the resulting SessionChunks via the active
 * classifier, and persists them through SqliteSessionStore.insertSession
 * with the embedder. Records adapter_state after each successful insert
 * so the next tick is incremental.
 *
 * Single-process: the scheduler runs alongside the HTTP server (Phase D
 * wires it into `nlm start`). No worker thread; Node's event loop is
 * enough — adapter discovery is filesystem-bound and the per-chunk
 * classify call is async-awaited with a wall-clock timeout to keep the
 * tick loop responsive.
 *
 * Confidence floor of 0.3 mirrors Python: classifier outputs below that
 * are skipped rather than persisted as low-quality noise.
 */
import type { LLMClient } from "../../ports/llm-client.js";
import type { TranscriptAdapter } from "../../ports/transcript-adapter.js";
import type { SqliteFactStore } from "../storage/sqlite-fact-store.js";
import type { SqliteSessionStore } from "../storage/sqlite-session-store.js";
export interface SchedulerOptions {
    readonly store: SqliteSessionStore;
    readonly adapters: ReadonlyArray<TranscriptAdapter>;
    readonly classifier: LLMClient;
    readonly embedder?: LLMClient | null;
    /**
     * FactStore for Phase B.2 fact ingest. When provided, the scheduler
     * extracts facts from each classify result and persists them atomically
     * with the session row. Optional — when null, sessions ingest as before
     * with no facts written (backwards-compatible default for tests not yet
     * updated, and for any future caller that wants facts off).
     */
    readonly factStore?: SqliteFactStore | null;
    readonly intervalMs?: number;
    readonly classifyTimeoutMs?: number;
    readonly confidenceFloor?: number;
    readonly idleMinutes?: number;
    /** Defaults to console.error. Set to a noop in tests. */
    readonly logger?: (msg: string) => void;
}
export interface TickReport {
    readonly inserted: number;
    readonly skippedLowConfidence: number;
    readonly classifyFailures: number;
    readonly storageFailures: number;
    readonly chunksSeen: number;
}
export declare class ScanScheduler {
    private readonly opts;
    private stopped;
    private timer;
    constructor(opts: SchedulerOptions);
    start(): void;
    stop(): void;
    private scheduleNext;
    tick(): Promise<TickReport>;
}
