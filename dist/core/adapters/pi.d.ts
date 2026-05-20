/**
 * Pi adapter.
 *
 * Reads ~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<uuid>.jsonl. Pi writes
 * session files even when a run aborts — those still ingest, but the adapter
 * flags them via the `gitBranch: "aborted"` sentinel (SessionChunk has no
 * status field; storage layer decodes the sentinel later).
 *
 * File shape (v3, confirmed 2026-05-18): one JSON object per line. Five
 * event types: session, model_change, thinking_level_change, message,
 * custom_message. Only `message` produces turns; the rest are configuration
 * or extension-injected (custom_message must be excluded).
 *
 * Discovery is recursive (`<sessions>/<cwd-slug>/<file>.jsonl`).
 * $PI_SESSIONS_PATH overrides the default path.
 */
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface PiAdapterOptions {
    readonly sessionsPath?: string;
    readonly idleMinutes?: number;
}
export declare class PiAdapter implements TranscriptAdapter {
    readonly name = "pi";
    readonly runtimeVersion = "pi/1.0";
    readonly transcriptKind = "pi-jsonl";
    private readonly sessionsPath;
    readonly idleMinutes: number;
    constructor(opts?: PiAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(path: string): Promise<SessionChunk | null>;
}
