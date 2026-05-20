/**
 * Generic JSONL adapter — driven by per-source `parseConfig`.
 *
 * Reads any directory of newline-delimited JSON files where each line is one
 * conversation turn. The three baked-in adapters (claude-code, hermes, pi)
 * stay as their own classes because each has format-specific quirks that
 * would bloat a generic config schema. This adapter exists for everything
 * else: Cursor, Codex, custom logs, anything a user can drop on disk in a
 * consistent shape.
 *
 * parseConfig shape (all optional except where noted):
 *   {
 *     "textField":         "content",     // required — the message body
 *     "roleField":         "role",        // optional — "user"/"assistant" filter
 *     "userRole":          "user",        // string the user role takes
 *     "assistantRole":     "assistant",   // string the assistant role takes
 *     "timestampField":    "timestamp",   // optional — ISO or unix
 *     "sessionIdField":    "session_id",  // optional — falls back to filename
 *     "labelField":        "title",       // optional — falls back to filename
 *     "filePattern":       "*.jsonl",     // glob within pathOrUrl
 *     "idleMinutes":       15
 *   }
 */
import { promises as fs, existsSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { durationMinutes, normalizeTimestamp, safeSessionId } from "./common.js";
export class JsonlGenericAdapter {
    name;
    runtimeVersion;
    transcriptKind = "jsonl-generic";
    idleMinutes;
    path;
    cfg;
    constructor(opts) {
        this.name = opts.name;
        this.runtimeVersion = opts.runtime;
        this.path = opts.path;
        this.idleMinutes = opts.config.idleMinutes ?? 15;
        this.cfg = {
            textField: opts.config.textField ?? "content",
            roleField: opts.config.roleField ?? "role",
            userRole: opts.config.userRole ?? "user",
            assistantRole: opts.config.assistantRole ?? "assistant",
            timestampField: opts.config.timestampField ?? "timestamp",
            sessionIdField: opts.config.sessionIdField ?? "session_id",
            labelField: opts.config.labelField ?? "title",
            filePattern: opts.config.filePattern ?? "*.jsonl",
        };
    }
    detect() {
        if (existsSync(this.path) && statSync(this.path).isDirectory()) {
            return { adapterName: this.name, enabled: true, path: this.path, hint: null };
        }
        return {
            adapterName: this.name,
            enabled: false,
            path: null,
            hint: `${this.name}: directory not found at ${this.path}`,
        };
    }
    async discover(options = {}) {
        if (!existsSync(this.path))
            return [];
        const entries = await fs.readdir(this.path, { withFileTypes: true });
        const wantExt = this.extOfPattern(this.cfg.filePattern);
        const out = [];
        for (const e of entries) {
            if (!e.isFile())
                continue;
            if (wantExt && extname(e.name) !== wantExt)
                continue;
            const full = join(this.path, e.name);
            if (options.since) {
                const st = statSync(full);
                if (st.mtime < options.since)
                    continue;
            }
            out.push(full);
        }
        return out;
    }
    async parseSession(filePath) {
        let raw;
        try {
            raw = await fs.readFile(filePath, "utf8");
        }
        catch {
            return null;
        }
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        if (lines.length === 0)
            return null;
        const turns = [];
        let sessionIdFromRows = null;
        let labelFromRows = null;
        for (const line of lines) {
            let row;
            try {
                row = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!sessionIdFromRows && typeof row[this.cfg.sessionIdField] === "string") {
                sessionIdFromRows = row[this.cfg.sessionIdField];
            }
            if (!labelFromRows && typeof row[this.cfg.labelField] === "string") {
                labelFromRows = row[this.cfg.labelField];
            }
            const role = this.classifyRole(row[this.cfg.roleField]);
            if (!role)
                continue;
            const text = this.extractText(row[this.cfg.textField]);
            if (!text)
                continue;
            turns.push({
                role,
                text,
                timestamp: normalizeTimestamp(row[this.cfg.timestampField]),
            });
        }
        if (turns.length === 0)
            return null;
        const startedAt = turns[0]?.timestamp ?? "";
        const endedAt = turns[turns.length - 1]?.timestamp ?? startedAt;
        const fileName = basename(filePath, extname(filePath));
        const rawId = sessionIdFromRows ?? fileName;
        const label = labelFromRows ?? fileName;
        const text = turns
            .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
            .join("\n\n");
        return {
            id: safeSessionId(this.name, rawId),
            runtime: this.runtimeVersion,
            runtimeSessionId: rawId,
            sourcePath: filePath,
            startedAt,
            endedAt,
            durationMin: durationMinutes(startedAt, endedAt),
            turnCount: turns.length,
            byteRange: [0, Buffer.byteLength(raw)],
            projectDir: this.path,
            gitBranch: "",
            text,
            label,
        };
    }
    classifyRole(raw) {
        if (raw === undefined || raw === null) {
            // Some formats omit the field — assume alternating; bias to assistant.
            return "assistant";
        }
        if (typeof raw !== "string")
            return null;
        if (raw === this.cfg.userRole)
            return "user";
        if (raw === this.cfg.assistantRole)
            return "assistant";
        return null;
    }
    extractText(raw) {
        if (typeof raw === "string")
            return raw.trim();
        if (Array.isArray(raw)) {
            // OpenAI-style content: [{ type: "text", text: "..." }, ...]
            const parts = [];
            for (const item of raw) {
                if (typeof item === "string")
                    parts.push(item);
                else if (item && typeof item === "object" && typeof item.text === "string") {
                    parts.push(item.text);
                }
            }
            return parts.join(" ").trim();
        }
        return "";
    }
    extOfPattern(pattern) {
        const idx = pattern.lastIndexOf(".");
        if (idx < 0)
            return null;
        return pattern.slice(idx);
    }
}
//# sourceMappingURL=jsonl-generic.js.map