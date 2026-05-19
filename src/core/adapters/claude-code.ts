/**
 * Claude Code adapter.
 *
 * Reads ~/.claude/projects/<encoded-path>/<uuid>.jsonl files. Each .jsonl is
 * one session containing structured events (user/assistant messages, tool
 * uses, snapshots). The adapter discovers files and parses one into a
 * normalized SessionChunk. The scan_once incremental path lives in the
 * Scheduler (Phase D); this slice is pure parsing.
 *
 * Format reference: verified on Edward's machine 2026-05-07. Each line is
 * a JSON object with a `type` field. Relevant types: user, assistant.
 * Tool envelopes are summarized inline so the classifier sees the
 * conversational flow but not raw JSON payloads.
 */

import { promises as fs } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import type {
  DetectionResult,
  DiscoverOptions,
  SessionChunk,
  TranscriptAdapter,
} from "@ports/transcript-adapter.js";
import { durationMinutes, safeSessionId } from "./common.js";

const TOOL_RESULT_PREVIEW_CHARS = 240;

export interface ClaudeCodeAdapterOptions {
  readonly projectsPath?: string;
  readonly idleMinutes?: number;
}

interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: string;
}

export class ClaudeCodeAdapter implements TranscriptAdapter {
  readonly name = "claude-code";
  readonly runtimeVersion = "claude-code/1.0";
  readonly transcriptKind = "claude-code-jsonl";

  private readonly projectsPath: string;
  readonly idleMinutes: number;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.projectsPath =
      opts.projectsPath ?? join(homedir(), ".claude", "projects");
    this.idleMinutes = opts.idleMinutes ?? 15;
  }

  detect(): DetectionResult {
    const p = join(homedir(), ".claude", "projects");
    if (existsSync(p) && statSync(p).isDirectory()) {
      return { adapterName: this.name, enabled: true, path: p, hint: null };
    }
    return {
      adapterName: this.name,
      enabled: false,
      path: null,
      hint: "Claude Code not detected — ~/.claude/projects/ missing.",
    };
  }

  async discover(options: DiscoverOptions = {}): Promise<ReadonlyArray<string>> {
    if (!existsSync(this.projectsPath)) return [];

    const found: { mtime: number; path: string }[] = [];
    const seen = new Set<string>();

    // Top-level sessions: <projects>/<project>/<uuid>.jsonl
    const projects = await fs.readdir(this.projectsPath, { withFileTypes: true });
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const projDir = join(this.projectsPath, proj.name);
      const entries = await fs.readdir(projDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isFile() && extname(ent.name) === ".jsonl") {
          await this.maybeAdd(join(projDir, ent.name), seen, found, options.since);
        } else if (ent.isDirectory()) {
          // Subagent transcripts: <project>/<uuid>/subagents/agent-<id>.jsonl
          const subDir = join(projDir, ent.name, "subagents");
          if (!existsSync(subDir)) continue;
          const subEntries = await fs.readdir(subDir, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && extname(sub.name) === ".jsonl") {
              await this.maybeAdd(join(subDir, sub.name), seen, found, options.since);
            }
          }
        }
      }
    }

    found.sort((a, b) => a.mtime - b.mtime);
    return found.map((f) => f.path);
  }

  async parseSession(path: string): Promise<SessionChunk | null> {
    const isSubagent = this.isSubagentPath(path);
    const turns: Turn[] = [];
    let startedAt = "";
    let endedAt = "";
    let projectDir = "";
    let gitBranch = "";
    let runtimeSessionId = "";
    let agentId = "";
    let agentSlug = "";
    let parentSessionId = "";
    let totalBytes = 0;

    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch {
      return null;
    }

    for (const line of raw.split("\n")) {
      totalBytes += Buffer.byteLength(line, "utf8") + 1; // +1 for newline
      const trimmed = line.trim();
      if (!trimmed) continue;

      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (!runtimeSessionId && typeof evt["sessionId"] === "string") {
        runtimeSessionId = evt["sessionId"];
      }
      if (isSubagent) {
        if (!agentId && typeof evt["agentId"] === "string") agentId = evt["agentId"];
        if (!agentSlug && typeof evt["slug"] === "string") agentSlug = evt["slug"];
        if (!parentSessionId && typeof evt["sessionId"] === "string") {
          parentSessionId = evt["sessionId"];
        }
      }
      if (!projectDir && typeof evt["cwd"] === "string") projectDir = evt["cwd"];
      if (!gitBranch && typeof evt["gitBranch"] === "string") gitBranch = evt["gitBranch"];

      const evtType = evt["type"];
      if (evtType !== "user" && evtType !== "assistant") continue;

      const msg = (evt["message"] as Record<string, unknown> | undefined) ?? {};
      const text = extractText(msg["content"]);
      if (!text.trim()) continue;

      const cleaned = evtType === "user" ? stripEnvelopes(text) : text;
      if (!cleaned.trim()) continue;

      const timestamp =
        typeof evt["timestamp"] === "string" ? evt["timestamp"] : "";
      if (timestamp && !startedAt) startedAt = timestamp;
      if (timestamp) endedAt = timestamp;

      turns.push({ role: evtType, text: cleaned, timestamp });
    }

    if (turns.length === 0) return null;

    const transcript = turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");
    const duration = durationMinutes(startedAt, endedAt);
    let label = provisionalLabel(turns);

    if (isSubagent && agentId) {
      const slugTag = agentSlug || "anon";
      label = `[subagent ${slugTag}] ${label}`;
      return {
        id: safeSessionId("cc_sub", agentId),
        runtime: this.runtimeVersion,
        runtimeSessionId: `${parentSessionId || "unknown"}/agent-${agentId}`,
        sourcePath: path,
        startedAt,
        endedAt,
        durationMin: duration,
        turnCount: turns.length,
        byteRange: [0, totalBytes],
        projectDir,
        gitBranch,
        text: transcript,
        label,
      };
    }

    const stem = basename(path, ".jsonl");
    const rawId = runtimeSessionId || stem;
    return {
      id: safeSessionId("cc", rawId),
      runtime: this.runtimeVersion,
      runtimeSessionId: runtimeSessionId || stem,
      sourcePath: path,
      startedAt,
      endedAt,
      durationMin: duration,
      turnCount: turns.length,
      byteRange: [0, totalBytes],
      projectDir,
      gitBranch,
      text: transcript,
      label,
    };
  }

  private isSubagentPath(path: string): boolean {
    return basename(dirname(path)) === "subagents";
  }

  private async maybeAdd(
    path: string,
    seen: Set<string>,
    out: { mtime: number; path: string }[],
    since?: Date,
  ): Promise<void> {
    if (seen.has(path)) return;
    seen.add(path);
    let st;
    try {
      st = await fs.stat(path);
    } catch {
      return;
    }
    if (st.size === 0) return;
    if (since && st.mtime < since) return;
    out.push({ mtime: st.mtimeMs, path });
  }
}

// ── content extraction ───────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const btype = b["type"];
    if (btype === "text") {
      const t = b["text"];
      if (typeof t === "string" && t) parts.push(t);
    } else if (btype === "tool_use") {
      const name = typeof b["name"] === "string" ? b["name"] : "tool";
      parts.push(`[tool_use: ${name}]`);
    } else if (btype === "tool_result") {
      let res = b["content"];
      if (Array.isArray(res)) {
        res = res
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
          .map((x) => (typeof x["text"] === "string" ? (x["text"] as string) : ""))
          .join("\n");
      }
      if (typeof res === "string" && res) {
        const preview = res.slice(0, TOOL_RESULT_PREVIEW_CHARS);
        const ellipsis = res.length > TOOL_RESULT_PREVIEW_CHARS ? "…" : "";
        parts.push(`[tool_result: ${preview}${ellipsis}]`);
      }
    } else if (btype === "image") {
      parts.push("[image]");
    }
  }
  return parts.filter((p) => p).join("\n");
}

const IDE_TAG_RE = /<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g;
const IDE_SELF_RE = /<ide_[^/]*?\/>/g;
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const COMMAND_RE = /<command-(?:name|message|args)>[^<]*<\/command-(?:name|message|args)>/g;

function stripEnvelopes(text: string): string {
  return text
    .replace(IDE_TAG_RE, "")
    .replace(IDE_SELF_RE, "")
    .replace(REMINDER_RE, "")
    .replace(COMMAND_RE, "")
    .trim();
}

function provisionalLabel(turns: ReadonlyArray<Turn>): string {
  for (const t of turns) {
    if (t.role !== "user") continue;
    const cleaned = stripEnvelopes(t.text);
    if (!cleaned) continue;
    const firstLine = cleaned.split("\n", 1)[0]?.trim();
    if (firstLine) return firstLine.slice(0, 80);
  }
  return "Untitled session";
}
