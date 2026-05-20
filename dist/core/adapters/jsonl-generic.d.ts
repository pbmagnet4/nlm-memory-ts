/**
 * Generic JSONL adapter — driven by per-source `parseConfig`.
 *
 * Reads any directory of newline-delimited JSON files where each line is one
 * conversation turn. The three baked-in adapters (claude-code, hermes, pi)
 * stay as their own classes because each has format-specific quirks that
 * would bloat a generic config schema. This adapter exists for everything
 * else: Cursor, Codex, custom logs, anything a user can drop on disk in a
 * consistent shape.
 *
 * parseConfig shape (all optional except where noted):
 *   {
 *     "textField":         "content",     // required — the message body
 *     "roleField":         "role",        // optional — "user"/"assistant" filter
 *     "userRole":          "user",        // string the user role takes
 *     "assistantRole":     "assistant",   // string the assistant role takes
 *     "timestampField":    "timestamp",   // optional — ISO or unix
 *     "sessionIdField":    "session_id",  // optional — falls back to filename
 *     "labelField":        "title",       // optional — falls back to filename
 *     "filePattern":       "*.jsonl",     // glob within pathOrUrl
 *     "idleMinutes":       15
 *   }
 */
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface JsonlGenericConfig {
    readonly textField?: string;
    readonly roleField?: string;
    readonly userRole?: string;
    readonly assistantRole?: string;
    readonly timestampField?: string;
    readonly sessionIdField?: string;
    readonly labelField?: string;
    readonly filePattern?: string;
    readonly idleMinutes?: number;
}
export interface JsonlGenericAdapterOptions {
    readonly name: string;
    readonly path: string;
    readonly runtime: string;
    readonly config: JsonlGenericConfig;
}
export declare class JsonlGenericAdapter implements TranscriptAdapter {
    readonly name: string;
    readonly runtimeVersion: string;
    readonly transcriptKind = "jsonl-generic";
    readonly idleMinutes: number;
    private readonly path;
    private readonly cfg;
    constructor(opts: JsonlGenericAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(filePath: string): Promise<SessionChunk | null>;
    private classifyRole;
    private extractText;
    private extOfPattern;
}
