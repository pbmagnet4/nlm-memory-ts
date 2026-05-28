/**
 * OpenCode adapter.
 *
 * Reads the OpenCode SQLite database at:
 *   macOS: ~/Library/Application Support/opencode/opencode.db
 *   Linux: $XDG_DATA_HOME/opencode/opencode.db (default ~/.local/share/opencode/opencode.db)
 *
 * Unlike the JSONL-based adapters, OpenCode stores all sessions and messages
 * in a single SQLite file. `discover()` queries the sessions table and returns
 * session IDs (not file paths). `parseSession()` treats its string argument as
 * a session ID and reconstructs a SessionChunk from the messages and parts tables.
 *
 * Part types extracted:
 *   - text  (non-ignored): the conversational prose
 *   - tool  : summarized as [tool: <name>]
 *   All other part types (reasoning, step-start/finish, snapshot, patch,
 *   compaction, agent, retry, subtask) are structural and skipped.
 *
 * Format reference: verified against sst/opencode migration
 * 20260127222353_familiar_lady_ursula and session.sql.ts, 2026-05-28.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type {
  DetectionResult,
  DiscoverOptions,
  SessionChunk,
  TranscriptAdapter,
} from "@ports/transcript-adapter.js";
import { durationMinutes, normalizeTimestamp } from "./common.js";

const TOOL_OUTPUT_PREVIEW_CHARS = 240;

export interface OpenCodeAdapterOptions {
  readonly dbPath?: string;
}

interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: string;
}

interface SessionRow {
  readonly id: string;
  readonly directory: string;
  readonly title: string;
  readonly time_created: number;
  readonly time_updated: number;
}

interface MessageRow {
  readonly id: string;
  readonly time_created: number;
  readonly data: string;
}

interface PartRow {
  readonly message_id: string;
  readonly time_created: number;
  readonly data: string;
}

interface MessageInfo {
  readonly role: "user" | "assistant";
}

interface TextPartData {
  readonly type: "text";
  readonly text: string;
  readonly ignored?: boolean;
}

interface ToolPartData {
  readonly type: "tool";
  readonly tool: string;
  readonly state?: Record<string, unknown>;
}

type PartData = TextPartData | ToolPartData | { readonly type: string };

export function defaultDbPath(): string {
  if (process.env["OPENCODE_DB_PATH"]) return process.env["OPENCODE_DB_PATH"];
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "opencode", "opencode.db");
  }
  const xdg = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
  return join(xdg, "opencode", "opencode.db");
}

function readGitBranch(directory: string): string {
  try {
    const head = readFileSync(join(directory, ".git", "HEAD"), "utf8").trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match ? (match[1] ?? "") : "";
  } catch {
    return "";
  }
}

function extractTurns(messages: MessageRow[], partsByMessage: Map<string, PartData[]>): Turn[] {
  const turns: Turn[] = [];
  for (const msg of messages) {
    let info: MessageInfo;
    try {
      info = JSON.parse(msg.data) as MessageInfo;
    } catch {
      continue;
    }
    if (info.role !== "user" && info.role !== "assistant") continue;

    const parts = partsByMessage.get(msg.id) ?? [];
    const segments: string[] = [];

    for (const p of parts) {
      if (p.type === "text") {
        const tp = p as TextPartData;
        if (!tp.ignored && tp.text) segments.push(tp.text);
      } else if (p.type === "tool") {
        const tp = p as ToolPartData;
        const output = extractToolOutput(tp);
        segments.push(output ? `[tool: ${tp.tool}] ${output}` : `[tool: ${tp.tool}]`);
      }
    }

    const text = segments.join("\n").trim();
    if (!text) continue;

    turns.push({ role: info.role, text, timestamp: normalizeTimestamp(msg.time_created) });
  }
  return turns;
}

function extractToolOutput(part: ToolPartData): string {
  const state = part.state;
  if (!state) return "";
  const output =
    (state["output"] as string | undefined) ??
    (state["result"] as string | undefined) ??
    "";
  if (typeof output !== "string" || !output) return "";
  const preview = output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
  return output.length > TOOL_OUTPUT_PREVIEW_CHARS ? `${preview}…` : preview;
}

function provisionalLabel(turns: ReadonlyArray<Turn>): string {
  for (const t of turns) {
    if (t.role !== "user") continue;
    const first = t.text.split("\n", 1)[0]?.trim();
    if (first) return first.slice(0, 80);
  }
  return "Untitled session";
}

export class OpenCodeAdapter implements TranscriptAdapter {
  readonly name = "opencode";
  readonly runtimeVersion = "opencode/1.0";
  readonly transcriptKind = "opencode-sqlite";

  private readonly dbPath: string;

  constructor(opts: OpenCodeAdapterOptions = {}) {
    this.dbPath = opts.dbPath ?? defaultDbPath();
  }

  detect(): DetectionResult {
    if (existsSync(this.dbPath)) {
      return { adapterName: this.name, enabled: true, path: this.dbPath, hint: null };
    }
    return { adapterName: this.name, enabled: false, path: null, hint: "opencode.db not found" };
  }

  async discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>> {
    if (!existsSync(this.dbPath)) return [];
    let db: Database.Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true });
      let rows: { id: string }[];
      if (options?.since) {
        const sinceMs = options.since.getTime();
        rows = db
          .prepare<[number], { id: string }>(
            `SELECT id FROM session WHERE time_archived IS NULL AND time_updated >= ?`,
          )
          .all(sinceMs);
      } else {
        rows = db
          .prepare<[], { id: string }>(
            `SELECT id FROM session WHERE time_archived IS NULL`,
          )
          .all();
      }
      return rows.map((r) => r.id);
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  async parseSession(sessionId: string): Promise<SessionChunk | null> {
    if (!existsSync(this.dbPath)) return null;
    let db: Database.Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true });

      const session = db
        .prepare<[string], SessionRow>(
          `SELECT id, directory, title, time_created, time_updated
           FROM session WHERE id = ?`,
        )
        .get(sessionId);
      if (!session) return null;

      const messages = db
        .prepare<[string], MessageRow>(
          `SELECT id, time_created, data FROM message
           WHERE session_id = ? ORDER BY time_created ASC`,
        )
        .all(sessionId);

      const partRows = db
        .prepare<[string], PartRow>(
          `SELECT message_id, time_created, data FROM part
           WHERE session_id = ? ORDER BY time_created ASC`,
        )
        .all(sessionId);

      const partsByMessage = new Map<string, PartData[]>();
      for (const row of partRows) {
        let data: PartData;
        try {
          data = JSON.parse(row.data) as PartData;
        } catch {
          continue;
        }
        const bucket = partsByMessage.get(row.message_id);
        if (bucket) {
          bucket.push(data);
        } else {
          partsByMessage.set(row.message_id, [data]);
        }
      }

      const turns = extractTurns(messages, partsByMessage);
      if (turns.length === 0) return null;

      const startedAt = normalizeTimestamp(session.time_created);
      const endedAt = normalizeTimestamp(session.time_updated);
      const transcript = turns.map((t) => `${t.role}: ${t.text}`).join("\n\n");

      const label =
        session.title && session.title !== "New session"
          ? session.title.slice(0, 80)
          : provisionalLabel(turns);

      return {
        id: `oc_${sessionId}`,
        runtime: this.runtimeVersion,
        runtimeSessionId: sessionId,
        sourcePath: `${this.dbPath}::${sessionId}`,
        startedAt,
        endedAt,
        durationMin: durationMinutes(startedAt, endedAt),
        turnCount: turns.length,
        byteRange: [0, Buffer.byteLength(transcript, "utf8")],
        projectDir: session.directory,
        gitBranch: readGitBranch(session.directory),
        text: transcript,
        label,
      };
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }
}
