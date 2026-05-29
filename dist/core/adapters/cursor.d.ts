/**
 * CursorAdapter — reads Cursor AI composer sessions from state.vscdb.
 *
 * Cursor stores all AI sessions in a global SQLite database at:
 *   macOS: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   Linux: ~/.config/Cursor/User/globalStorage/state.vscdb
 *
 * The database uses a key-value table `cursorDiskKV`:
 *   composerData:<composerId>  — session metadata (name, createdAt, lastUpdatedAt,
 *                                modelConfig, inline conversation[] OR separate bubbles)
 *   bubbleId:<composerId>:<bubbleId>  — individual messages (separate storage, v1.5+)
 *
 * Message type: 1 = user, 2 = assistant.
 * Messages are extracted from inline `conversation[]` when present; otherwise
 * from `bubbleId:*` rows ordered by rowid ASC (insertion order).
 *
 * sourcePath: <dbPath>::<composerId>
 *
 * Env override: NLM_CURSOR_DB_PATH
 */
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface CursorAdapterOptions {
    readonly dbPath?: string;
}
export declare function defaultDbPath(): string;
export declare class CursorAdapter implements TranscriptAdapter {
    readonly name = "cursor";
    readonly runtimeVersion = "cursor/1.0";
    readonly transcriptKind = "cursor-sqlite";
    private readonly dbPath;
    constructor(opts?: CursorAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(composerId: string): Promise<SessionChunk | null>;
}
