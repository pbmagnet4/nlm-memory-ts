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
import { promises as fs, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { homedir } from "node:os";
import { durationMinutes, normalizeTimestamp, safeSessionId, } from "./common.js";
const TOOL_RESULT_PREVIEW_CHARS = 240;
function defaultSessionsPath() {
    return (process.env["PI_SESSIONS_PATH"] ??
        join(homedir(), ".pi", "agent", "sessions"));
}
export class PiAdapter {
    name = "pi";
    runtimeVersion = "pi/1.0";
    transcriptKind = "pi-jsonl";
    sessionsPath;
    idleMinutes;
    constructor(opts = {}) {
        this.sessionsPath = opts.sessionsPath ?? defaultSessionsPath();
        this.idleMinutes = opts.idleMinutes ?? 15;
    }
    detect() {
        const p = defaultSessionsPath();
        if (existsSync(p) && statSync(p).isDirectory()) {
            return { adapterName: this.name, enabled: true, path: p, hint: null };
        }
        return {
            adapterName: this.name,
            enabled: false,
            path: null,
            hint: "Pi not detected — ~/.pi/agent/sessions/ missing.",
        };
    }
    async discover(options = {}) {
        if (!existsSync(this.sessionsPath))
            return [];
        const found = [];
        await walk(this.sessionsPath, async (full, st) => {
            if (st.size === 0)
                return;
            if (extname(full) !== ".jsonl")
                return;
            if (options.since && st.mtime < options.since)
                return;
            found.push({ mtime: st.mtimeMs, path: full });
        });
        found.sort((a, b) => a.mtime - b.mtime);
        return found.map((f) => f.path);
    }
    async parseSession(path) {
        let raw;
        try {
            raw = await fs.readFile(path, "utf8");
        }
        catch {
            return null;
        }
        const turns = [];
        let sessionId = "";
        let projectDir = "";
        let startedAt = "";
        let endedAt = "";
        let totalBytes = 0;
        let allAssistantErrors = true;
        for (const line of raw.split("\n")) {
            totalBytes += Buffer.byteLength(line, "utf8") + 1;
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            let evt;
            try {
                evt = JSON.parse(trimmed);
            }
            catch {
                continue;
            }
            const evtType = evt["type"];
            if (evtType === "session") {
                if (typeof evt["id"] === "string")
                    sessionId = evt["id"];
                if (typeof evt["cwd"] === "string")
                    projectDir = evt["cwd"];
                continue;
            }
            if (evtType === "model_change" ||
                evtType === "thinking_level_change" ||
                evtType === "custom_message") {
                continue;
            }
            if (evtType !== "message")
                continue;
            const msg = isRecord(evt["message"]) ? evt["message"] : {};
            const role = msg["role"];
            if (role !== "user" && role !== "assistant")
                continue;
            const innerTs = msg["timestamp"];
            const outerTs = evt["timestamp"];
            const ts = innerTs
                ? normalizeTimestamp(innerTs)
                : normalizeTimestamp(outerTs);
            if (ts) {
                if (!startedAt)
                    startedAt = ts;
                endedAt = ts;
            }
            const text = extractPiText(msg["content"]);
            if (role === "assistant") {
                const stop = typeof msg["stopReason"] === "string" ? msg["stopReason"] : "";
                if (stop !== "error")
                    allAssistantErrors = false;
                if (!text.trim())
                    continue; // error turns have empty content
            }
            else if (!text.trim()) {
                continue;
            }
            turns.push({ role, text, timestamp: ts });
        }
        if (turns.length === 0)
            return null;
        const hasUser = turns.some((t) => t.role === "user");
        const hasSuccessfulAssistant = turns.some((t) => t.role === "assistant");
        const isAborted = hasUser && (!hasSuccessfulAssistant || allAssistantErrors);
        const transcript = turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");
        const duration = durationMinutes(startedAt, endedAt);
        const label = provisionalLabel(turns);
        const rawId = sessionId || path.split("/").pop().replace(".jsonl", "");
        return {
            id: safeSessionId("pi", rawId),
            runtime: this.runtimeVersion,
            runtimeSessionId: rawId,
            sourcePath: path,
            startedAt,
            endedAt,
            durationMin: duration,
            turnCount: turns.length,
            byteRange: [0, totalBytes],
            projectDir,
            gitBranch: isAborted ? "aborted" : "",
            text: transcript,
            label,
        };
    }
}
// ── helpers ──────────────────────────────────────────────────────────────
function isRecord(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}
async function walk(dir, onFile) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const ent of entries) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
            await walk(full, onFile);
        }
        else if (ent.isFile()) {
            try {
                const st = await fs.stat(full);
                await onFile(full, st);
            }
            catch {
                continue;
            }
        }
    }
}
function extractPiText(content) {
    if (typeof content === "string")
        return content.trim();
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const block of content) {
        if (!isRecord(block))
            continue;
        const btype = block["type"];
        if (btype === "text") {
            const t = block["text"];
            if (typeof t === "string" && t.trim())
                parts.push(t.trim());
        }
        else if (btype === "tool_use") {
            const name = typeof block["name"] === "string" ? block["name"] : "tool";
            parts.push(`[tool_use: ${name}]`);
        }
        else if (btype === "tool_result") {
            let res = block["content"];
            if (Array.isArray(res)) {
                res = res
                    .filter(isRecord)
                    .map((b) => (typeof b["text"] === "string" ? b["text"] : ""))
                    .join("\n");
            }
            if (typeof res === "string" && res) {
                const preview = res.slice(0, TOOL_RESULT_PREVIEW_CHARS);
                const ellipsis = res.length > TOOL_RESULT_PREVIEW_CHARS ? "..." : "";
                parts.push(`[tool_result: ${preview}${ellipsis}]`);
            }
        }
    }
    return parts.filter((p) => p).join("\n");
}
function provisionalLabel(turns) {
    for (const t of turns) {
        if (t.role !== "user")
            continue;
        const firstLine = t.text.split("\n", 1)[0]?.trim();
        if (firstLine)
            return firstLine.slice(0, 80);
    }
    return "Untitled session";
}
//# sourceMappingURL=pi.js.map