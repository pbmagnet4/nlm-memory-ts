/**
 * Claude Code adapter.
 *
 * Reads ~/.claude/projects/<encoded-path>/<uuid>.jsonl files. Each .jsonl is
 * one session containing structured events (user/assistant messages, tool
 * uses, snapshots). The adapter discovers files and parses one into a
 * normalized SessionChunk. The scan_once incremental path lives in the
 * Scheduler (Phase D); this slice is pure parsing.
 *
 * Format reference: verified on Edward's machine 2026-05-07. Each line is
 * a JSON object with a `type` field. Relevant types: user, assistant.
 * Tool envelopes are summarized inline so the classifier sees the
 * conversational flow but not raw JSON payloads.
 */
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface ClaudeCodeAdapterOptions {
    readonly projectsPath?: string;
    readonly idleMinutes?: number;
}
export declare class ClaudeCodeAdapter implements TranscriptAdapter {
    readonly name = "claude-code";
    readonly runtimeVersion = "claude-code/1.0";
    readonly transcriptKind = "claude-code-jsonl";
    private readonly projectsPath;
    readonly idleMinutes: number;
    constructor(opts?: ClaudeCodeAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(path: string): Promise<SessionChunk | null>;
    private isSubagentPath;
    private maybeAdd;
}
