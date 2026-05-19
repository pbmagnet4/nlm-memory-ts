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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

export type SourceKind = "claude-code" | "hermes" | "pi" | "jsonl-generic" | "webhook";

export interface SourceRow {
  readonly id: number;
  readonly kind: SourceKind;
  readonly name: string;
  readonly pathOrUrl: string | null;
  readonly runtimeLabel: string;
  readonly parseConfig: Record<string, unknown>;
  readonly enabled: boolean;
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
  created_at: string;
  updated_at: string;
}

function rowFromDb(r: SourceDbRow): SourceRow {
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class SourceRegistry {
  constructor(private readonly db: Database.Database) {}

  list(): SourceRow[] {
    const rows = this.db.prepare<[], SourceDbRow>(
      `SELECT * FROM sources ORDER BY id ASC`,
    ).all();
    return rows.map(rowFromDb);
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
    const stmt = this.db.prepare(`
      INSERT INTO sources (kind, name, path_or_url, runtime_label, parse_config, enabled)
      VALUES (@kind, @name, @path_or_url, @runtime_label, @parse_config, @enabled)
    `);
    const result = stmt.run({
      kind: input.kind,
      name: input.name,
      path_or_url: input.pathOrUrl ?? null,
      runtime_label: input.runtimeLabel,
      parse_config: JSON.stringify(input.parseConfig ?? {}),
      enabled: input.enabled === false ? 0 : 1,
    });
    const id = Number(result.lastInsertRowid);
    const row = this.get(id);
    if (!row) throw new Error(`SourceRegistry.insert: row ${id} not found after insert`);
    return row;
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

    const claudePath = process.env["NLE_CLAUDE_PROJECTS_PATH"]
      ?? join(homedir(), ".claude", "projects");
    const hermesPath = process.env["NLE_HERMES_SESSIONS_PATH"]
      ?? join(homedir(), ".hermes", "sessions");
    const piPath = process.env["PI_SESSIONS_PATH"]
      ?? join(homedir(), ".pi", "agent", "sessions");

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
