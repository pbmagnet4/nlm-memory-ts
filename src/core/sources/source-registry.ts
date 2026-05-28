/**
 * SourceRegistry — CRUD over the `sources` table.
 *
 * A "source" is any transcript origin the daemon scans (Claude Code's
 * projects dir, Hermes's sessions dir, pi.dev, a user-defined JSONL
 * directory, or a webhook).
 *
 * The three legacy adapters (claude-code, hermes, pi) seed as preset rows
 * pointing at fixed `path_or_url` values. The generic JSONL adapter and
 * webhook ingest piggy-back on this same table — the scheduler chooses
 * which adapter to dispatch by reading `kind`.
 *
 * See docs/plans/desktop-product.md (Phase 0).
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { defaultDbPath as defaultOpenCodeDbPath } from "../adapters/opencode.js";

export type SourceKind = "claude-code" | "hermes" | "opencode" | "pi" | "jsonl-generic" | "webhook";

export interface SourceRow {
  readonly id: number;
  readonly kind: SourceKind;
  readonly name: string;
  readonly pathOrUrl: string | null;
  readonly runtimeLabel: string;
  readonly parseConfig: Record<string, unknown>;
  readonly enabled: boolean;
  /** Only populated on the response from `insert()` for webhook sources.
   *  Always `null` from `list()` / `get()`. Use `getToken()` inside the daemon. */
  readonly token: string | null;
  readonly hasToken: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SourceInsert {
  readonly kind: SourceKind;
  readonly name: string;
  readonly pathOrUrl?: string | null;
  readonly runtimeLabel: string;
  readonly parseConfig?: Record<string, unknown>;
  readonly enabled?: boolean;
}

export interface SourceUpdate {
  readonly name?: string;
  readonly pathOrUrl?: string | null;
  readonly runtimeLabel?: string;
  readonly parseConfig?: Record<string, unknown>;
  readonly enabled?: boolean;
}

interface SourceDbRow {
  id: number;
  kind: string;
  name: string;
  path_or_url: string | null;
  runtime_label: string;
  parse_config: string;
  enabled: number;
  token: string | null;
  created_at: string;
  updated_at: string;
}

function rowFromDb(r: SourceDbRow, revealedToken: string | null = null): SourceRow {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = r.parse_config ? (JSON.parse(r.parse_config) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  return {
    id: r.id,
    kind: r.kind as SourceKind,
    name: r.name,
    pathOrUrl: r.path_or_url,
    runtimeLabel: r.runtime_label,
    parseConfig: parsed,
    enabled: r.enabled === 1,
    token: revealedToken,
    hasToken: r.token !== null && r.token.length > 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mintToken(): string {
  return `nlm_${randomBytes(24).toString("hex")}`;
}

export class SourceRegistry {
  constructor(private readonly db: Database.Database) {}

  list(): SourceRow[] {
    const rows = this.db.prepare<[], SourceDbRow>(
      `SELECT * FROM sources ORDER BY id ASC`,
    ).all();
    return rows.map((r) => rowFromDb(r));
  }

  get(id: number): SourceRow | null {
    const row = this.db.prepare<[number], SourceDbRow>(
      `SELECT * FROM sources WHERE id = ?`,
    ).get(id);
    return row ? rowFromDb(row) : null;
  }

  getByName(name: string): SourceRow | null {
    const row = this.db.prepare<[string], SourceDbRow>(
      `SELECT * FROM sources WHERE name = ?`,
    ).get(name);
    return row ? rowFromDb(row) : null;
  }

  insert(input: SourceInsert): SourceRow {
    const token = input.kind === "webhook" ? mintToken() : null;
    const stmt = this.db.prepare(`
      INSERT INTO sources (kind, name, path_or_url, runtime_label, parse_config, enabled, token)
      VALUES (@kind, @name, @path_or_url, @runtime_label, @parse_config, @enabled, @token)
    `);
    const result = stmt.run({
      kind: input.kind,
      name: input.name,
      path_or_url: input.pathOrUrl ?? null,
      runtime_label: input.runtimeLabel,
      parse_config: JSON.stringify(input.parseConfig ?? {}),
      enabled: input.enabled === false ? 0 : 1,
      token,
    });
    const id = Number(result.lastInsertRowid);
    const dbRow = this.db.prepare<[number], SourceDbRow>(
      `SELECT * FROM sources WHERE id = ?`,
    ).get(id);
    if (!dbRow) throw new Error(`SourceRegistry.insert: row ${id} not found after insert`);
    // Reveal the token on the insert response only — this is the user's
    // one chance to copy it. Subsequent list/get redact.
    return rowFromDb(dbRow, token);
  }

  /** Daemon-internal: resolve a bearer token to its owning source. */
  findByToken(token: string): SourceRow | null {
    if (!token) return null;
    const row = this.db.prepare<[string], SourceDbRow>(
      `SELECT * FROM sources WHERE token = ?`,
    ).get(token);
    return row ? rowFromDb(row) : null;
  }

  /** Daemon-internal: returns the raw token. Never echo to HTTP responses. */
  getToken(id: number): string | null {
    const row = this.db.prepare<[number], SourceDbRow>(
      `SELECT token FROM sources WHERE id = ?`,
    ).get(id);
    return row?.token ?? null;
  }

  /** Mint a fresh token, invalidating any previous one. */
  regenerateToken(id: number): string | null {
    const current = this.get(id);
    if (!current || current.kind !== "webhook") return null;
    const token = mintToken();
    this.db.prepare(`UPDATE sources SET token = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(token, id);
    return token;
  }

  update(id: number, patch: SourceUpdate): SourceRow | null {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.name !== undefined) { fields.push("name = @name"); params["name"] = patch.name; }
    if (patch.pathOrUrl !== undefined) { fields.push("path_or_url = @path"); params["path"] = patch.pathOrUrl; }
    if (patch.runtimeLabel !== undefined) { fields.push("runtime_label = @rt"); params["rt"] = patch.runtimeLabel; }
    if (patch.parseConfig !== undefined) { fields.push("parse_config = @cfg"); params["cfg"] = JSON.stringify(patch.parseConfig); }
    if (patch.enabled !== undefined) { fields.push("enabled = @en"); params["en"] = patch.enabled ? 1 : 0; }
    if (fields.length === 0) return this.get(id);
    fields.push("updated_at = datetime('now')");
    this.db.prepare(`UPDATE sources SET ${fields.join(", ")} WHERE id = @id`).run(params);
    return this.get(id);
  }

  delete(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM sources WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /**
   * Seed the three legacy adapter presets on first boot of an empty
   * registry. Subsequent boots are no-ops. Respects per-runtime env
   * overrides so existing installs don't lose their custom paths.
   */
  seedDefaults(): void {
    const count = this.db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM sources`).get();
    if ((count?.c ?? 0) > 0) return;

    const claudePath = process.env["NLM_CLAUDE_PROJECTS_PATH"]
      ?? join(homedir(), ".claude", "projects");
    const hermesPath = process.env["NLM_HERMES_SESSIONS_PATH"]
      ?? join(homedir(), ".hermes", "sessions");
    const piPath = process.env["PI_SESSIONS_PATH"]
      ?? join(homedir(), ".pi", "agent", "sessions");

    const openCodeDbPath = defaultOpenCodeDbPath();

    const presets: SourceInsert[] = [
      {
        kind: "claude-code",
        name: "Claude Code",
        pathOrUrl: claudePath,
        runtimeLabel: "claude-code/1.0",
        enabled: existsSync(claudePath),
      },
      {
        kind: "hermes",
        name: "Hermes",
        pathOrUrl: hermesPath,
        runtimeLabel: "hermes/1.0",
        enabled: existsSync(hermesPath),
      },
      {
        kind: "opencode",
        name: "OpenCode",
        pathOrUrl: openCodeDbPath,
        runtimeLabel: "opencode/1.0",
        enabled: existsSync(openCodeDbPath),
      },
      {
        kind: "pi",
        name: "pi.dev",
        pathOrUrl: piPath,
        runtimeLabel: "pi/1.0",
        enabled: existsSync(piPath),
      },
    ];
    for (const p of presets) this.insert(p);
  }
}
