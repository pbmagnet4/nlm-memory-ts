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
import { promises as fs } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { durationMinutes, safeSessionId } from "./common.js";
const TOOL_RESULT_PREVIEW_CHARS = 240;
export class CodexAdapter {
    name = "codex";
    runtimeVersion = "codex/1.0";
    transcriptKind = "codex-jsonl";
    sessionsPath;
    idleMinutes;
    constructor(opts = {}) {
        this.sessionsPath =
            opts.sessionsPath ?? join(homedir(), ".codex", "sessions");
        this.idleMinutes = opts.idleMinutes ?? 15;
    }
    detect() {
        const p = join(homedir(), ".codex", "sessions");
        if (existsSync(p) && statSync(p).isDirectory()) {
            return { adapterName: this.name, enabled: true, path: p, hint: null };
        }
        return {
            adapterName: this.name,
            enabled: false,
            path: null,
            hint: "Codex not detected — ~/.codex/sessions/ missing. Install with `npm i -g @openai/codex`.",
        };
    }
    async discover(options = {}) {
        if (!existsSync(this.sessionsPath))
            return [];
        const found = [];
        const seen = new Set();
        await this.walk(this.sessionsPath, seen, found, options.since);
        found.sort((a, b) => a.mtime - b.mtime);
        return found.map((f) => f.path);
    }
    async parseSession(path) {
        const turns = [];
        let startedAt = "";
        let endedAt = "";
        let projectDir = "";
        let runtimeSessionId = "";
        let totalBytes = 0;
        let raw;
        try {
            raw = await fs.readFile(path, "utf8");
        }
        catch {
            return null;
        }
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
            const outerType = evt["type"];
            const outerTs = typeof evt["timestamp"] === "string" ? evt["timestamp"] : "";
            const payload = evt["payload"] ?? {};
            if (outerType === "session_meta") {
                if (typeof payload["id"] === "string")
                    runtimeSessionId = payload["id"];
                if (!projectDir && typeof payload["cwd"] === "string") {
                    projectDir = payload["cwd"];
                }
                const metaTs = typeof payload["timestamp"] === "string" ? payload["timestamp"] : outerTs;
                if (metaTs && !startedAt)
                    startedAt = metaTs;
                if (metaTs)
                    endedAt = metaTs;
                continue;
            }
            const turn = extractTurn(outerType, payload, outerTs);
            if (!turn)
                continue;
            if (turn.timestamp && !startedAt)
                startedAt = turn.timestamp;
            if (turn.timestamp)
                endedAt = turn.timestamp;
            turns.push(turn);
        }
        if (turns.length === 0)
            return null;
        const transcript = turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");
        const duration = durationMinutes(startedAt, endedAt);
        const label = provisionalLabel(turns);
        const stem = basename(path, ".jsonl");
        const rawId = runtimeSessionId || stem;
        return {
            id: safeSessionId("codex", rawId),
            runtime: this.runtimeVersion,
            runtimeSessionId: runtimeSessionId || stem,
            sourcePath: path,
            startedAt,
            endedAt,
            durationMin: duration,
            turnCount: turns.length,
            byteRange: [0, totalBytes],
            projectDir,
            gitBranch: "",
            text: transcript,
            label,
        };
    }
    async walk(dir, seen, out, since) {
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
                await this.walk(full, seen, out, since);
            }
            else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
                if (seen.has(full))
                    continue;
                seen.add(full);
                let st;
                try {
                    st = await fs.stat(full);
                }
                catch {
                    continue;
                }
                if (st.size === 0)
                    continue;
                if (since && st.mtime < since)
                    continue;
                out.push({ mtime: st.mtimeMs, path: full });
            }
        }
    }
}
// ── event extraction ─────────────────────────────────────────────────────
function extractTurn(outerType, payload, outerTs) {
    if (outerType === "event_msg") {
        const pType = payload["type"];
        if (pType === "user_message") {
            const text = typeof payload["message"] === "string" ? payload["message"] : "";
            if (!text.trim())
                return null;
            return { role: "user", text, timestamp: outerTs };
        }
        if (pType === "agent_message") {
            const phase = payload["phase"];
            if (phase && phase !== "final_answer")
                return null;
            const text = typeof payload["message"] === "string" ? payload["message"] : "";
            if (!text.trim())
                return null;
            return { role: "assistant", text, timestamp: outerTs };
        }
        return null;
    }
    if (outerType === "response_item") {
        const pType = payload["type"];
        if (pType === "function_call" || pType === "custom_tool_call") {
            const name = typeof payload["name"] === "string" ? payload["name"] : "tool";
            return { role: "assistant", text: `[tool_use: ${name}]`, timestamp: outerTs };
        }
        if (pType === "function_call_output" || pType === "custom_tool_call_output") {
            const output = payload["output"];
            const outStr = typeof output === "string" ? output : "";
            if (!outStr)
                return null;
            const preview = outStr.slice(0, TOOL_RESULT_PREVIEW_CHARS);
            const ellipsis = outStr.length > TOOL_RESULT_PREVIEW_CHARS ? "…" : "";
            return {
                role: "assistant",
                text: `[tool_result: ${preview}${ellipsis}]`,
                timestamp: outerTs,
            };
        }
        return null;
    }
    return null;
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
//# sourceMappingURL=codex.js.map