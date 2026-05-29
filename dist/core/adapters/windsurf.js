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
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { durationMinutes, safeSessionId } from "./common.js";
const CHAT_KEY = "workbench.panel.aichat.view.aichat.chatdata";
const TOOL_RESULT_PREVIEW_CHARS = 240;
export function defaultUserDir() {
    if (process.env["NLM_WINDSURF_USER_DIR"])
        return process.env["NLM_WINDSURF_USER_DIR"];
    const home = homedir();
    if (process.platform === "darwin") {
        return join(home, "Library/Application Support/Windsurf/User");
    }
    return join(home, ".config/Windsurf/User");
}
function workspaceStorageDir(userDir) {
    return join(userDir, "workspaceStorage");
}
function listWorkspaceDbs(userDir) {
    const wsDir = workspaceStorageDir(userDir);
    if (!existsSync(wsDir))
        return [];
    try {
        return readdirSync(wsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => join(wsDir, e.name, "state.vscdb"))
            .filter((p) => existsSync(p));
    }
    catch {
        return [];
    }
}
function parseTabsFromDb(dbPath) {
    let db;
    try {
        db = new Database(dbPath, { readonly: true });
        const row = db
            .prepare(`SELECT key, value FROM ItemTable WHERE key = ?`)
            .get(CHAT_KEY);
        if (!row?.value)
            return [];
        const data = JSON.parse(row.value);
        return Array.isArray(data.tabs) ? data.tabs : [];
    }
    catch {
        return [];
    }
    finally {
        db?.close();
    }
}
function extractTurns(bubbles) {
    const turns = [];
    for (const b of bubbles) {
        const text = (b.rawText ?? b.text ?? "").trim();
        if (!text)
            continue;
        const role = b.type === "user" ? "user" : "assistant";
        turns.push({ role, text });
    }
    return turns;
}
export class WindsurfAdapter {
    name = "windsurf";
    runtimeVersion = "windsurf/1.0";
    transcriptKind = "windsurf-sqlite";
    userDir;
    constructor(opts = {}) {
        this.userDir = opts.userDir ?? defaultUserDir();
    }
    detect() {
        const wsDir = workspaceStorageDir(this.userDir);
        if (existsSync(this.userDir)) {
            return { adapterName: this.name, enabled: true, path: this.userDir, hint: null };
        }
        return {
            adapterName: this.name,
            enabled: false,
            path: null,
            hint: "Windsurf User directory not found — install Windsurf or set NLM_WINDSURF_USER_DIR.",
        };
    }
    async discover(options) {
        const dbPaths = listWorkspaceDbs(this.userDir);
        if (dbPaths.length === 0)
            return [];
        const found = [];
        const cutoff = options?.since?.getTime();
        for (const dbPath of dbPaths) {
            const tabs = parseTabsFromDb(dbPath);
            for (const tab of tabs) {
                if (!tab.tabId)
                    continue;
                if (!(tab.bubbles && tab.bubbles.length > 0))
                    continue;
                if (cutoff !== undefined) {
                    const ts = tab.lastSendTime;
                    if (ts !== undefined && ts < cutoff)
                        continue;
                }
                found.push({ tabId: tab.tabId, dbPath, lastSendTime: tab.lastSendTime ?? 0 });
            }
        }
        // Deduplicate by tabId (a tab should only appear in one workspace DB,
        // but guard against edge cases from workspaceStorage migration artifacts)
        const seen = new Set();
        return found
            .filter((t) => {
            if (seen.has(t.tabId))
                return false;
            seen.add(t.tabId);
            return true;
        })
            .map((t) => t.tabId);
    }
    async parseSession(tabId) {
        const dbPaths = listWorkspaceDbs(this.userDir);
        for (const dbPath of dbPaths) {
            const tabs = parseTabsFromDb(dbPath);
            const tab = tabs.find((t) => t.tabId === tabId);
            if (!tab)
                continue;
            const bubbles = tab.bubbles ?? [];
            const turns = extractTurns(bubbles);
            if (turns.length === 0)
                return null;
            // Windsurf tabs carry lastSendTime (epoch ms) but no per-tab createdAt.
            const endedAtMs = tab.lastSendTime ?? 0;
            const endedAt = endedAtMs > 0 ? new Date(endedAtMs).toISOString() : "";
            const startedAt = endedAt; // no creation timestamp available
            const transcript = turns.map((t) => `${t.role}: ${t.text}`).join("\n\n");
            const label = tab.chatTitle?.trim()
                ? tab.chatTitle.trim().slice(0, 80)
                : (turns.find((t) => t.role === "user")?.text.split("\n")[0]?.trim().slice(0, 80) ?? "Untitled session");
            return {
                id: safeSessionId("ws", tabId),
                runtime: this.runtimeVersion,
                runtimeSessionId: tabId,
                sourcePath: `${dbPath}::${tabId}`,
                startedAt,
                endedAt,
                durationMin: durationMinutes(startedAt, endedAt),
                turnCount: turns.length,
                byteRange: [0, Buffer.byteLength(transcript, "utf8")],
                projectDir: "",
                gitBranch: "",
                text: transcript,
                label,
            };
        }
        return null;
    }
}
//# sourceMappingURL=windsurf.js.map