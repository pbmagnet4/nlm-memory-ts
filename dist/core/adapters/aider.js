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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { durationMinutes, safeSessionId } from "./common.js";
export function defaultHistoryFile() {
    return (process.env["AIDER_CHAT_HISTORY_FILE"] ??
        join(homedir(), ".aider.chat.history.md"));
}
// Matches "# aider chat started at YYYY-MM-DD HH:MM:SS"
const SESSION_HEADER_RE = /^# aider chat started at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
const TOOL_ACTION_PREVIEW_CHARS = 200;
function rawTimestampToId(raw) {
    // "2024-05-28 14:30:45" → "20240528_143045"
    const compact = raw
        .replace(/-/g, "")
        .replace(/ /, "_")
        .replace(/:/g, "");
    return safeSessionId("ai", compact);
}
function processAssistantText(text) {
    return text
        .split("\n")
        .map((line) => {
        if (!line.startsWith("> "))
            return line;
        const content = line.slice(2).trim().slice(0, TOOL_ACTION_PREVIEW_CHARS);
        return `[tool_action: ${content}]`;
    })
        .join("\n")
        .trim();
}
function extractTurns(body) {
    // Normalize so every turn block is preceded by \n####
    const normalized = body.startsWith("#### ") ? "\n" + body : body;
    const chunks = normalized.split("\n#### ").slice(1); // drop preamble
    const turns = [];
    for (const chunk of chunks) {
        const nlIdx = chunk.indexOf("\n");
        const userText = (nlIdx === -1 ? chunk : chunk.slice(0, nlIdx)).trim();
        const rest = nlIdx === -1 ? "" : chunk.slice(nlIdx + 1).trim();
        if (userText)
            turns.push({ role: "user", text: userText });
        if (rest) {
            const processed = processAssistantText(rest);
            if (processed)
                turns.push({ role: "assistant", text: processed });
        }
    }
    return turns;
}
function parseHistoryFile(filePath) {
    let content;
    try {
        content = readFileSync(filePath, "utf-8");
    }
    catch {
        return [];
    }
    const lines = content.split("\n");
    const sessionStarts = [];
    for (let i = 0; i < lines.length; i++) {
        if (SESSION_HEADER_RE.test(lines[i] ?? ""))
            sessionStarts.push(i);
    }
    if (sessionStarts.length === 0)
        return [];
    const sessions = [];
    for (let si = 0; si < sessionStarts.length; si++) {
        const startLine = sessionStarts[si];
        const endLine = si + 1 < sessionStarts.length ? sessionStarts[si + 1] : lines.length;
        const headerLine = lines[startLine] ?? "";
        const match = SESSION_HEADER_RE.exec(headerLine);
        if (!match)
            continue;
        const rawTimestamp = match[1];
        const startedAt = new Date(rawTimestamp).toISOString();
        const id = rawTimestampToId(rawTimestamp);
        const body = lines.slice(startLine + 1, endLine).join("\n");
        const turns = extractTurns(body);
        sessions.push({ rawTimestamp, id, startedAt, turns });
    }
    return sessions;
}
export class AiderAdapter {
    name = "aider";
    runtimeVersion = "aider/1.0";
    transcriptKind = "aider-markdown";
    historyFile;
    constructor(opts = {}) {
        this.historyFile = opts.historyFile ?? defaultHistoryFile();
    }
    detect() {
        if (existsSync(this.historyFile)) {
            return { adapterName: this.name, enabled: true, path: this.historyFile, hint: null };
        }
        return {
            adapterName: this.name,
            enabled: false,
            path: null,
            hint: "Aider chat history not found — run aider in a project or set AIDER_CHAT_HISTORY_FILE.",
        };
    }
    async discover(options) {
        if (!existsSync(this.historyFile))
            return [];
        const sessions = parseHistoryFile(this.historyFile);
        if (options?.since) {
            const cutoff = options.since.getTime();
            return sessions
                .filter((s) => new Date(s.startedAt).getTime() >= cutoff)
                .map((s) => s.id);
        }
        return sessions.map((s) => s.id);
    }
    async parseSession(id) {
        if (!existsSync(this.historyFile))
            return null;
        const sessions = parseHistoryFile(this.historyFile);
        const idx = sessions.findIndex((s) => s.id === id);
        if (idx === -1)
            return null;
        const session = sessions[idx];
        if (session.turns.length === 0)
            return null;
        const nextSession = sessions[idx + 1];
        const endedAt = nextSession ? nextSession.startedAt : session.startedAt;
        const text = session.turns.map((t) => `${t.role}: ${t.text}`).join("\n\n");
        const firstUser = session.turns.find((t) => t.role === "user");
        const label = firstUser
            ? firstUser.text.split("\n")[0]?.trim().slice(0, 80) ?? session.rawTimestamp
            : session.rawTimestamp;
        return {
            id: session.id,
            runtime: this.runtimeVersion,
            runtimeSessionId: session.id,
            sourcePath: `${this.historyFile}::${session.rawTimestamp}`,
            startedAt: session.startedAt,
            endedAt,
            durationMin: durationMinutes(session.startedAt, endedAt),
            turnCount: session.turns.length,
            byteRange: [0, Buffer.byteLength(text, "utf8")],
            projectDir: "",
            gitBranch: "",
            text,
            label,
        };
    }
}
//# sourceMappingURL=aider.js.map