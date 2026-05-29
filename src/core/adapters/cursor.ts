/**
 * CursorAdapter — reads Cursor AI composer sessions from state.vscdb.
 *
 * Cursor stores all AI sessions in a global SQLite database at:
 *   macOS: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   Linux: ~/.config/Cursor/User/globalStorage/state.vscdb
 *
 * The database uses a key-value table `cursorDiskKV`:
 *   composerData:<composerId>  — session metadata (name, createdAt, lastUpdatedAt,
 *                                modelConfig, inline conversation[] OR separate bubbles)
 *   bubbleId:<composerId>:<bubbleId>  — individual messages (separate storage, v1.5+)
 *
 * Message type: 1 = user, 2 = assistant.
 * Messages are extracted from inline `conversation[]` when present; otherwise
 * from `bubbleId:*` rows ordered by rowid ASC (insertion order).
 *
 * sourcePath: <dbPath>::<composerId>
 *
 * Env override: NLM_CURSOR_DB_PATH
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type {
  DetectionResult,
  DiscoverOptions,
  SessionChunk,
  TranscriptAdapter,
} from "@ports/transcript-adapter.js";
import { durationMinutes, normalizeTimestamp, safeSessionId } from "./common.js";

const TOOL_RESULT_PREVIEW_CHARS = 240;

export interface CursorAdapterOptions {
  readonly dbPath?: string;
}

interface KVRow {
  readonly key: string;
  readonly value: string | null;
}

interface ComposerMeta {
  readonly composerId: string;
  readonly name?: string;
  readonly createdAt?: unknown;
  readonly lastUpdatedAt?: unknown;
  readonly conversation?: BubbleData[];
}

interface BubbleData {
  readonly type?: number;
  readonly text?: string;
  readonly toolResults?: unknown[];
  readonly toolFormerData?: unknown;
}

export function defaultDbPath(): string {
  if (process.env["NLM_CURSOR_DB_PATH"]) return process.env["NLM_CURSOR_DB_PATH"];
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  }
  return join(home, ".config/Cursor/User/globalStorage/state.vscdb");
}

function parseBubble(bubble: BubbleData): { role: "user" | "assistant"; text: string } | null {
  const type = bubble.type;
  if (type !== 1 && type !== 2) return null;
  const role = type === 1 ? "user" : "assistant";
  const text = (bubble.text ?? "").trim();
  if (!text) return null;
  return { role, text };
}

function extractTurnsFromBubbles(bubbles: BubbleData[]): Array<{ role: "user" | "assistant"; text: string }> {
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const b of bubbles) {
    const turn = parseBubble(b);
    if (turn) turns.push(turn);
  }
  return turns;
}

function extractSeparateBubbles(
  db: Database.Database,
  composerId: string,
): Array<{ role: "user" | "assistant"; text: string }> {
  const rows = db
    .prepare<[string], KVRow>(
      `SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC`,
    )
    .all(`bubbleId:${composerId}:%`);

  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const row of rows) {
    if (!row.value) continue;
    let bubble: BubbleData;
    try {
      bubble = JSON.parse(row.value) as BubbleData;
    } catch {
      continue;
    }
    const turn = parseBubble(bubble);
    if (turn) turns.push(turn);
  }
  return turns;
}

function provisionalLabel(turns: ReadonlyArray<{ role: string; text: string }>): string {
  for (const t of turns) {
    if (t.role !== "user") continue;
    const first = t.text.split("\n", 1)[0]?.trim();
    if (first) return first.slice(0, 80);
  }
  return "Untitled session";
}

export class CursorAdapter implements TranscriptAdapter {
  readonly name = "cursor";
  readonly runtimeVersion = "cursor/1.0";
  readonly transcriptKind = "cursor-sqlite";

  private readonly dbPath: string;

  constructor(opts: CursorAdapterOptions = {}) {
    this.dbPath = opts.dbPath ?? defaultDbPath();
  }

  detect(): DetectionResult {
    if (existsSync(this.dbPath)) {
      return { adapterName: this.name, enabled: true, path: this.dbPath, hint: null };
    }
    return {
      adapterName: this.name,
      enabled: false,
      path: null,
      hint: "Cursor global DB not found — install Cursor or set NLM_CURSOR_DB_PATH.",
    };
  }

  async discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>> {
    if (!existsSync(this.dbPath)) return [];
    let db: Database.Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true });

      // Verify the table exists (workspace DBs use ItemTable, not cursorDiskKV)
      const tableCheck = db
        .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'`)
        .get();
      if (!tableCheck) return [];

      const rows = db
        .prepare<[string], KVRow>(`SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC`)
        .all("composerData:%");

      const ids: string[] = [];
      const cutoff = options?.since?.getTime();

      for (const row of rows) {
        if (!row.value) continue;
        let meta: ComposerMeta;
        try {
          meta = JSON.parse(row.value) as ComposerMeta;
        } catch {
          continue;
        }

        if (cutoff !== undefined) {
          // Filter by lastUpdatedAt or createdAt
          const ts = meta.lastUpdatedAt ?? meta.createdAt;
          if (ts !== undefined && ts !== null) {
            const normalized = normalizeTimestamp(ts);
            if (normalized && Date.parse(normalized) < cutoff) continue;
          }
        }

        const composerId = meta.composerId ?? row.key.split(":").slice(1).join(":");
        if (composerId) ids.push(composerId);
      }
      return ids;
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  async parseSession(composerId: string): Promise<SessionChunk | null> {
    if (!existsSync(this.dbPath)) return null;
    let db: Database.Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true });

      const row = db
        .prepare<[string], KVRow>(`SELECT key, value FROM cursorDiskKV WHERE key = ?`)
        .get(`composerData:${composerId}`);
      if (!row?.value) return null;

      let meta: ComposerMeta;
      try {
        meta = JSON.parse(row.value) as ComposerMeta;
      } catch {
        return null;
      }

      // Extract turns: inline conversation[] preferred; fall back to separate bubbleId rows
      const inlineConversation = meta.conversation ?? [];
      const turns =
        inlineConversation.length > 0
          ? extractTurnsFromBubbles(inlineConversation)
          : extractSeparateBubbles(db, composerId);

      if (turns.length === 0) return null;

      const startedAt = normalizeTimestamp(meta.createdAt ?? meta.lastUpdatedAt ?? "");
      const endedAt = normalizeTimestamp(meta.lastUpdatedAt ?? meta.createdAt ?? "");
      const transcript = turns.map((t) => `${t.role}: ${t.text}`).join("\n\n");
      const label =
        meta.name?.trim()
          ? meta.name.trim().slice(0, 80)
          : provisionalLabel(turns);

      return {
        id: safeSessionId("cr", composerId),
        runtime: this.runtimeVersion,
        runtimeSessionId: composerId,
        sourcePath: `${this.dbPath}::${composerId}`,
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
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }
}
