/**
 * scanOnce — mtime-gated incremental discovery shared by every adapter.
 *
 * The Python codebase bundled this logic into each adapter (`scan_once` +
 * `record_classified` methods). In the TS port the adapter stays a pure
 * parser (TranscriptAdapter port); the mtime check and adapter_state
 * upsert live here, generic over the adapter. Same behavior, less
 * duplication across claude-code / hermes / pi.
 *
 * Contract (per file under adapter.discover()):
 *   - If `now - mtime < idleMinutes * 60s` → still active, skip
 *   - Lookup adapter_state by (adapterName, sourcePath):
 *       no row + file idle      → NEW: parse + return (chunk, supersedes=null)
 *       row exists, size match  → UNCHANGED: skip
 *       row exists, file grew   → RESUMED: parse + return (chunk, prior.session_id)
 *   - After successful classify+insert downstream, call `recordClassified`
 *     to upsert adapter_state with the new size + session_id.
 */
import type Database from "better-sqlite3";
import type { SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface ScanResult {
    readonly chunk: SessionChunk;
    readonly supersedes: string | null;
}
export declare function scanOnce(adapter: TranscriptAdapter, idleMinutes: number, db: Database.Database, now?: number): Promise<ReadonlyArray<ScanResult>>;
export declare function recordClassified(db: Database.Database, adapterName: string, sourcePath: string, sessionId: string): void;
