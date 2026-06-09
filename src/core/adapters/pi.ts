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
import type {
  DetectionResult,
  DiscoverOptions,
  SessionChunk,
  TranscriptAdapter,
} from "@ports/transcript-adapter.js";
import {
  durationMinutes,
  normalizeTimestamp,
  safeSessionId,
} from "./common.js";

const TOOL_RESULT_PREVIEW_CHARS = 240;

export interface PiAdapterOptions {
  readonly sessionsPath?: string;
  readonly idleMinutes?: number;
}

interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: string;
}

function defaultSessionsPath(): string {
  return (
    process.env["PI_SESSIONS_PATH"] ??
    join(homedir(), ".pi", "agent", "sessions")
  );
}

export class PiAdapter implements TranscriptAdapter {
  readonly name = "pi";
  readonly runtimeVersion = "pi/1.0";
  readonly transcriptKind = "pi-jsonl";

  private readonly sessionsPath: string;
  readonly idleMinutes: number;

  constructor(opts: PiAdapterOptions = {}) {
    this.sessionsPath = opts.sessionsPath ?? defaultSessionsPath();
    this.idleMinutes = opts.idleMinutes ?? 15;
  }

  detect(): DetectionResult {
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

  async discover(options: DiscoverOptions = {}): Promise<ReadonlyArray<string>> {
    if (!existsSync(this.sessionsPath)) return [];

    const found: { mtime: number; path: string }[] = [];
    await walk(this.sessionsPath, async (full, st) => {
      if (st.size === 0) return;
      if (extname(full) !== ".jsonl") return;
      if (options.since && st.mtime < options.since) return;
      found.push({ mtime: st.mtimeMs, path: full });
    });
    found.sort((a, b) => a.mtime - b.mtime);
    return found.map((f) => f.path);
  }

  async parseSession(path: string): Promise<SessionChunk | null> {
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch {
      return null;
    }

    const turns: Turn[] = [];
    const signals: unknown[] = [];
    let sessionId = "";
    let projectDir = "";
    let startedAt = "";
    let endedAt = "";
    let totalBytes = 0;
    let allAssistantErrors = true;

    for (const line of raw.split("\n")) {
      totalBytes += Buffer.byteLength(line, "utf8") + 1;
      const trimmed = line.trim();
      if (!trimmed) continue;

      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      const evtType = evt["type"];

      if (evtType === "session") {
        if (typeof evt["id"] === "string") sessionId = evt["id"];
        if (typeof evt["cwd"] === "string") projectDir = evt["cwd"];
        continue;
      }
      if (evtType === "custom") {
        if (evt["customType"] === "nlm.signal") {
          const payload = evt["data"];
          if (payload && typeof payload === "object") signals.push(payload);
        }
        continue;
      }
      if (
        evtType === "custom_message" ||
        evtType === "model_change" ||
        evtType === "thinking_level_change"
      ) {
        continue;
      }
      if (evtType !== "message") continue;

      const msg = isRecord(evt["message"]) ? (evt["message"] as Record<string, unknown>) : {};
      const role = msg["role"];
      if (role !== "user" && role !== "assistant") continue;

      const innerTs = msg["timestamp"];
      const outerTs = evt["timestamp"];
      const ts = innerTs
        ? normalizeTimestamp(innerTs)
        : normalizeTimestamp(outerTs);
      if (ts) {
        if (!startedAt) startedAt = ts;
        endedAt = ts;
      }

      const text = extractPiText(msg["content"]);

      if (role === "assistant") {
        const stop = typeof msg["stopReason"] === "string" ? msg["stopReason"] : "";
        if (stop !== "error") allAssistantErrors = false;
        if (!text.trim()) continue; // error turns have empty content
      } else if (!text.trim()) {
        continue;
      }

      turns.push({ role, text, timestamp: ts });
    }

    if (turns.length === 0) return null;

    const hasUser = turns.some((t) => t.role === "user");
    const hasSuccessfulAssistant = turns.some((t) => t.role === "assistant");
    const isAborted =
      hasUser && (!hasSuccessfulAssistant || allAssistantErrors);

    const transcript = turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");
    const duration = durationMinutes(startedAt, endedAt);
    const label = provisionalLabel(turns);
    const rawId = sessionId || path.split("/").pop()!.replace(".jsonl", "");

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
      ...(signals.length > 0 ? { signals } : {}),
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function walk(
  dir: string,
  onFile: (path: string, st: import("node:fs").Stats) => Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(full, onFile);
    } else if (ent.isFile()) {
      try {
        const st = await fs.stat(full);
        await onFile(full, st);
      } catch {
        continue;
      }
    }
  }
}

function extractPiText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const btype = block["type"];
    if (btype === "text") {
      const t = block["text"];
      if (typeof t === "string" && t.trim()) parts.push(t.trim());
    } else if (btype === "tool_use") {
      const name = typeof block["name"] === "string" ? block["name"] : "tool";
      parts.push(`[tool_use: ${name}]`);
    } else if (btype === "tool_result") {
      let res = block["content"];
      if (Array.isArray(res)) {
        res = res
          .filter(isRecord)
          .map((b) => (typeof b["text"] === "string" ? (b["text"] as string) : ""))
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

function provisionalLabel(turns: ReadonlyArray<Turn>): string {
  for (const t of turns) {
    if (t.role !== "user") continue;
    const firstLine = t.text.split("\n", 1)[0]?.trim();
    if (firstLine) return firstLine.slice(0, 80);
  }
  return "Untitled session";
}
