/**
 * Hermes adapter.
 *
 * Reads ~/.hermes/sessions/*.json files. Two file shapes coexist:
 *
 *   session_<date>_<id>.json     — live session format
 *     { session_id, model, session_start, last_updated, messages: [...] }
 *
 *   request_dump_<date>_<id>_<date>_<time>.json  — error-dump format
 *     { timestamp, session_id, request: { body: { messages: [...] } } }
 *
 * Discovery dedupes by `session_id`: when both shapes exist for the same
 * session (failure case), the live `session_` file wins because it carries
 * richer metadata.
 */
import { promises as fs, existsSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { durationMinutes, normalizeTimestamp, safeSessionId, } from "./common.js";
const TOOL_RESULT_PREVIEW_CHARS = 200;
export class HermesAdapter {
    name = "hermes";
    runtimeVersion = "hermes/1.0";
    transcriptKind = "hermes-json";
    sessionsPath;
    idleMinutes;
    constructor(opts = {}) {
        this.sessionsPath =
            opts.sessionsPath ?? join(homedir(), ".hermes", "sessions");
        this.idleMinutes = opts.idleMinutes ?? 30;
    }
    detect() {
        const p = join(homedir(), ".hermes", "sessions");
        if (existsSync(p) && statSync(p).isDirectory()) {
            return { adapterName: this.name, enabled: true, path: p, hint: null };
        }
        return {
            adapterName: this.name,
            enabled: false,
            path: null,
            hint: "Hermes not detected — ~/.hermes/sessions/ missing.",
        };
    }
    async discover(options = {}) {
        if (!existsSync(this.sessionsPath))
            return [];
        const allFiles = [];
        const entries = await fs.readdir(this.sessionsPath, { withFileTypes: true });
        for (const ent of entries) {
            if (!ent.isFile() || extname(ent.name) !== ".json")
                continue;
            const full = join(this.sessionsPath, ent.name);
            const st = await fs.stat(full);
            if (st.size === 0)
                continue;
            allFiles.push(full);
        }
        // Build session_id → {session, dump} map, preferring session_ files.
        const bySid = new Map();
        for (const jf of allFiles) {
            let data;
            try {
                const raw = await fs.readFile(jf, "utf8");
                data = JSON.parse(raw);
            }
            catch {
                continue;
            }
            const sidVal = data["session_id"];
            const sid = typeof sidVal === "string" && sidVal ? sidVal : basename(jf, ".json");
            const hasMessages = "messages" in data && !("request" in data);
            const slot = hasMessages ? "session" : "dump";
            const cur = bySid.get(sid) ?? {};
            cur[slot] = jf;
            bySid.set(sid, cur);
        }
        const chosen = [];
        for (const variants of bySid.values()) {
            const canonical = variants.session ?? variants.dump;
            if (!canonical)
                continue;
            const st = await fs.stat(canonical);
            if (options.since && st.mtime < options.since)
                continue;
            chosen.push({ mtime: st.mtimeMs, path: canonical });
        }
        chosen.sort((a, b) => a.mtime - b.mtime);
        return chosen.map((c) => c.path);
    }
    async parseSession(path) {
        let data;
        try {
            const raw = await fs.readFile(path, "utf8");
            data = JSON.parse(raw);
        }
        catch {
            return null;
        }
        let totalBytes = 0;
        try {
            totalBytes = (await fs.stat(path)).size;
        }
        catch {
            return null;
        }
        let msgs;
        let sessionId;
        let fileStartedAt;
        let fileEndedAt;
        if ("messages" in data && !isRecord(data["request"])) {
            // Live session format
            msgs = Array.isArray(data["messages"]) ? data["messages"] : [];
            sessionId =
                typeof data["session_id"] === "string" && data["session_id"]
                    ? data["session_id"]
                    : basename(path, ".json");
            fileStartedAt =
                typeof data["session_start"] === "string" ? data["session_start"] : "";
            fileEndedAt =
                typeof data["last_updated"] === "string" ? data["last_updated"] : "";
        }
        else {
            // Request dump format
            const body = isRecord(data["request"]) && isRecord(data["request"]["body"])
                ? data["request"]["body"]
                : {};
            msgs = Array.isArray(body["messages"]) ? body["messages"] : [];
            sessionId =
                typeof data["session_id"] === "string" && data["session_id"]
                    ? data["session_id"]
                    : basename(path, ".json");
            const ts = typeof data["timestamp"] === "string" ? data["timestamp"] : "";
            fileStartedAt = ts;
            fileEndedAt = ts;
        }
        if (msgs.length === 0)
            return null;
        fileStartedAt = normalizeTimestamp(fileStartedAt);
        fileEndedAt = normalizeTimestamp(fileEndedAt);
        const turns = [];
        let firstTs = "";
        let lastTs = "";
        for (const m of msgs) {
            if (!isRecord(m))
                continue;
            const role = typeof m["role"] === "string" ? m["role"] : "";
            if (!role || role === "system")
                continue;
            const toolCalls = Array.isArray(m["tool_calls"])
                ? m["tool_calls"]
                : null;
            const text = extractHermesText(m["content"], toolCalls);
            if (!text.trim())
                continue;
            const msgTs = normalizeTimestamp(m["timestamp"]);
            if (msgTs) {
                if (!firstTs)
                    firstTs = msgTs;
                lastTs = msgTs;
            }
            turns.push({ role, text, timestamp: msgTs });
        }
        if (turns.length === 0)
            return null;
        if (!firstTs && fileStartedAt)
            firstTs = fileStartedAt;
        if (!lastTs && fileEndedAt)
            lastTs = fileEndedAt;
        const transcript = turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");
        const duration = durationMinutes(firstTs, lastTs);
        const label = provisionalLabel(turns);
        return {
            id: safeSessionId("hm", sessionId),
            runtime: this.runtimeVersion,
            runtimeSessionId: sessionId,
            sourcePath: path,
            startedAt: firstTs,
            endedAt: lastTs,
            durationMin: duration,
            turnCount: turns.length,
            byteRange: [0, totalBytes],
            projectDir: "",
            gitBranch: "",
            text: transcript,
            label,
        };
    }
}
// ── helpers ──────────────────────────────────────────────────────────────
function isRecord(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}
function extractHermesText(content, toolCalls) {
    const parts = [];
    if (typeof content === "string") {
        const t = content.trim();
        if (t)
            parts.push(t);
    }
    else if (Array.isArray(content)) {
        for (const block of content) {
            if (!isRecord(block))
                continue;
            const btype = block["type"];
            if (btype === "text") {
                const txt = block["text"];
                if (typeof txt === "string" && txt.trim())
                    parts.push(txt.trim());
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
                    const ellipsis = res.length > TOOL_RESULT_PREVIEW_CHARS ? "…" : "";
                    parts.push(`[tool_result: ${preview}${ellipsis}]`);
                }
            }
        }
    }
    if (toolCalls) {
        for (const tc of toolCalls) {
            if (!isRecord(tc))
                continue;
            const fn = isRecord(tc["function"]) ? tc["function"] : {};
            const name = typeof fn["name"] === "string" ? fn["name"] : "tool";
            parts.push(`[tool_use: ${name}]`);
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
//# sourceMappingURL=hermes.js.map