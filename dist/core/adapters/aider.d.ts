/**
 * AiderAdapter — reads .aider.chat.history.md files.
 *
 * Aider stores chat sessions as Markdown in a per-project file. Each session
 * begins with a H1 header "# aider chat started at YYYY-MM-DD HH:MM:SS".
 * User turns are H4 headings (####); assistant responses are the plain text
 * that follows. Blockquote lines ("> ...") are Aider tool/file actions and
 * are summarized as [tool_action: ...].
 *
 * Default path: $AIDER_CHAT_HISTORY_FILE, or ~/.aider.chat.history.md.
 * For per-project files, configure pathOrUrl in the source registry.
 *
 * Session IDs: derived from the session header timestamp as ai_YYYYMMDD_HHMMSS.
 * sourcePath: <historyFile>::<rawTimestamp>  (e.g. ".../.aider.chat.history.md::2024-05-28 14:30:45")
 *
 * endedAt: next session's startedAt when available, else same as startedAt
 * (Aider's markdown format carries no per-turn or end-of-session timestamps).
 */
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface AiderAdapterOptions {
    readonly historyFile?: string;
}
export declare function defaultHistoryFile(): string;
export declare class AiderAdapter implements TranscriptAdapter {
    readonly name = "aider";
    readonly runtimeVersion = "aider/1.0";
    readonly transcriptKind = "aider-markdown";
    private readonly historyFile;
    constructor(opts?: AiderAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(id: string): Promise<SessionChunk | null>;
}
