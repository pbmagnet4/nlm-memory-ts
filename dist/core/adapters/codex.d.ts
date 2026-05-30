/**
 * Codex adapter.
 *
 * Reads ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl files. Each rollout is
 * one session containing a `session_meta` header line plus a stream of
 * `event_msg`, `response_item`, `turn_context`, and `token_count` events.
 *
 * Conversation extraction prefers `event_msg` payloads (`user_message`,
 * `agent_message`) over `response_item.message` payloads, because Codex
 * stuffs AGENTS.md and permission preambles into a synthetic
 * `response_item.message` with role=user on session start. Pulling the
 * conversation from `event_msg` sidesteps that envelope entirely without
 * needing a regex strip.
 *
 * Tool surface: `response_item.function_call` / `custom_tool_call` →
 * `[tool_use: <name>]`. `response_item.function_call_output` /
 * `custom_tool_call_output` → `[tool_result: <preview>]`. Reasoning,
 * web_search_call, turn_context, token_count, and task lifecycle events
 * are intentionally dropped — they are noise for recall purposes.
 *
 * Format reference: verified against Edward's ~/.codex/sessions on
 * 2026-05-30 (codex 0.134.0).
 */
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface CodexAdapterOptions {
    readonly sessionsPath?: string;
    readonly idleMinutes?: number;
}
export declare class CodexAdapter implements TranscriptAdapter {
    readonly name = "codex";
    readonly runtimeVersion = "codex/1.0";
    readonly transcriptKind = "codex-jsonl";
    private readonly sessionsPath;
    readonly idleMinutes: number;
    constructor(opts?: CodexAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(path: string): Promise<SessionChunk | null>;
    private walk;
}
