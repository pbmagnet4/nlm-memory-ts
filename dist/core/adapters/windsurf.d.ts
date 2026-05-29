/**
 * WindsurfAdapter — reads Windsurf (Codeium) Cascade chat sessions.
 *
 * Windsurf is a VS Code fork; chat history lives in workspace-scoped SQLite
 * databases under the User data directory:
 *
 *   macOS: ~/Library/Application Support/Windsurf/User/workspaceStorage/<hash>/state.vscdb
 *   Linux: ~/.config/Windsurf/User/workspaceStorage/<hash>/state.vscdb
 *
 * Each workspace DB uses an `ItemTable` key-value store. Chat tabs are stored
 * under key `workbench.panel.aichat.view.aichat.chatdata` as a JSON object
 * with a `tabs[]` array. Each tab is a conversation session.
 *
 * Tab message format:
 *   type: 'user' | 'ai'  (string, not int — distinct from Cursor)
 *   rawText / text: content
 *
 * pathOrUrl: path to the User directory (adapter discovers all workspace DBs
 * from <userDir>/workspaceStorage/).
 *
 * sourcePath: <dbPath>::<tabId>
 *
 * Env override: NLM_WINDSURF_USER_DIR
 */
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface WindsurfAdapterOptions {
    readonly userDir?: string;
}
export declare function defaultUserDir(): string;
export declare class WindsurfAdapter implements TranscriptAdapter {
    readonly name = "windsurf";
    readonly runtimeVersion = "windsurf/1.0";
    readonly transcriptKind = "windsurf-sqlite";
    private readonly userDir;
    constructor(opts?: WindsurfAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(tabId: string): Promise<SessionChunk | null>;
}
