/**
 * SqliteSessionStore — the canonical SessionStore implementation backed by
 * better-sqlite3 with the sqlite-vec extension loaded for KNN search.
 *
 * Layering note: core/ imports this concrete class only at the composition
 * root (CLI / server bootstrap). The recall use case and every other piece
 * of core depends on the SessionStore *port*, never on this file.
 *
 * Schema parity with the Python daemon: sessions row + session_entities +
 * markers + session_embeddings (vec0). Idle-status overlay (computed from
 * transcript mtime) is deferred to a later phase — A.2 returns the persisted
 * status verbatim.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type {
  SemanticNeighbor,
  SessionFilter,
  SessionStore,
} from "@ports/session-store.js";
import type {
  Session,
  SessionStatus,
} from "@shared/types.js";
import { liveSessionStatus } from "./live-status.js";
import { runMigrations } from "./migrate.js";

export interface SqliteSessionStoreOptions {
  readonly dbPath: string;
  readonly migrationsDir: string;
  readonly readonly?: boolean;
}

type SessionRow = {
  id: string;
  runtime: string;
  runtime_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  duration_min: number | null;
  label: string;
  summary: string;
  status: "active" | "closed" | "superseded";
  transcript_kind: string | null;
  transcript_path: string | null;
  body: string | null;
};

type EntityRow = { session_id: string; entity_canonical: string };
type MarkerRow = { session_id: string; kind: "decision" | "open"; text: string };
type NeighborRow = { session_id: string; distance: number };

export class SqliteSessionStore implements SessionStore {
  private readonly db: Database.Database;

  constructor(opts: SqliteSessionStoreOptions) {
    const dbPath = resolve(opts.dbPath);
    const parent = dirname(dbPath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

    this.db = new Database(dbPath, opts.readonly ? { readonly: true } : {});
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");

    sqliteVec.load(this.db);

    if (!opts.readonly) {
      runMigrations(this.db, opts.migrationsDir);
    }
  }

  close(): void {
    this.db.close();
  }

  async list(filter?: SessionFilter): Promise<ReadonlyArray<Session>> {
    const rows = this.db
      .prepare<[], SessionRow>(`
        SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
               label, summary, status, transcript_kind, transcript_path, body
        FROM sessions
        ORDER BY started_at ASC
      `)
      .all();

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const entitiesByIdMap = this.loadEntities(ids);
    const markersByIdMap = this.loadMarkers(ids);

    const sessions = rows.map((r) => this.rowToSession(r, entitiesByIdMap, markersByIdMap));

    if (!filter) return sessions;
    return sessions.filter((s) => {
      if (filter.entity !== undefined && !s.entities.includes(filter.entity)) {
        return false;
      }
      if (filter.hasDecisions === true && s.decisions.length === 0) return false;
      if (filter.hasOpenQuestions === true && s.open.length === 0) return false;
      return true;
    });
  }

  async getById(sessionId: string): Promise<Session | null> {
    const row = this.db
      .prepare<[string], SessionRow>(`
        SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
               label, summary, status, transcript_kind, transcript_path, body
        FROM sessions
        WHERE id = ?
      `)
      .get(sessionId);

    if (!row) return null;
    const entities = this.loadEntities([sessionId]);
    const markers = this.loadMarkers([sessionId]);
    return this.rowToSession(row, entities, markers);
  }

  async semanticSearch(
    queryVector: Float32Array,
    limit: number,
  ): Promise<ReadonlyArray<SemanticNeighbor>> {
    const k = Math.max(1, Math.trunc(limit));
    const blob = Buffer.from(
      queryVector.buffer,
      queryVector.byteOffset,
      queryVector.byteLength,
    );
    const rows = this.db
      .prepare<[Buffer, number], NeighborRow>(`
        SELECT session_id, distance
        FROM session_embeddings
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `)
      .all(blob, k);

    return rows.map((r) => ({ sessionId: r.session_id, distance: r.distance }));
  }

  async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    if (status === "idle") {
      throw new Error("Cannot persist derived status 'idle' — only active/closed/superseded");
    }
    this.db
      .prepare(
        "UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(status, sessionId);
  }

  // ── insert helpers used by tests / future ingest path ─────────────────
  insertSessionForTest(session: Session): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, runtime, runtime_session_id, started_at, ended_at, duration_min,
        label, summary, body, status, transcript_kind, transcript_path
      ) VALUES (
        @id, @runtime, @runtimeSessionId, @startedAt, @endedAt, @durationMin,
        @label, @summary, @body, @status, @transcriptKind, @transcriptPath
      )
    `);
    const status: SessionStatus = session.status === "idle" ? "active" : session.status;
    stmt.run({
      id: session.id,
      runtime: session.runtime,
      runtimeSessionId: session.runtimeSessionId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMin: session.durationMin,
      label: session.label,
      summary: session.summary,
      body: session.body,
      status,
      transcriptKind: session.transcriptKind,
      transcriptPath: session.transcriptPath,
    });

    const entStmt = this.db.prepare(`
      INSERT OR IGNORE INTO entities (canonical, type, status)
      VALUES (?, 'candidate', 'active')
    `);
    const linkStmt = this.db.prepare(
      "INSERT OR IGNORE INTO session_entities (session_id, entity_canonical) VALUES (?, ?)",
    );
    for (const e of session.entities) {
      entStmt.run(e);
      linkStmt.run(session.id, e);
    }

    const markerStmt = this.db.prepare(
      "INSERT INTO markers (session_id, kind, text, position) VALUES (?, ?, ?, ?)",
    );
    session.decisions.forEach((d, i) => markerStmt.run(session.id, "decision", d, i));
    session.open.forEach((q, i) => markerStmt.run(session.id, "open", q, i));
  }

  insertEmbeddingForTest(sessionId: string, vector: Float32Array): void {
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db
      .prepare(
        "INSERT INTO session_embeddings (session_id, embedding) VALUES (?, ?)",
      )
      .run(sessionId, blob);
  }

  // ── internal ──────────────────────────────────────────────────────────
  private loadEntities(ids: ReadonlyArray<string>): Map<string, string[]> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare<string[], EntityRow>(`
        SELECT session_id, entity_canonical
        FROM session_entities
        WHERE session_id IN (${placeholders})
        ORDER BY session_id
      `)
      .all(...ids);

    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.session_id);
      if (list) list.push(r.entity_canonical);
      else out.set(r.session_id, [r.entity_canonical]);
    }
    return out;
  }

  private loadMarkers(
    ids: ReadonlyArray<string>,
  ): Map<string, { decisions: string[]; open: string[] }> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare<string[], MarkerRow>(`
        SELECT session_id, kind, text
        FROM markers
        WHERE session_id IN (${placeholders})
        ORDER BY session_id, position
      `)
      .all(...ids);

    const out = new Map<string, { decisions: string[]; open: string[] }>();
    for (const r of rows) {
      let bucket = out.get(r.session_id);
      if (!bucket) {
        bucket = { decisions: [], open: [] };
        out.set(r.session_id, bucket);
      }
      if (r.kind === "decision") bucket.decisions.push(r.text);
      else bucket.open.push(r.text);
    }
    return out;
  }

  private rowToSession(
    row: SessionRow,
    entitiesById: Map<string, string[]>,
    markersById: Map<string, { decisions: string[]; open: string[] }>,
  ): Session {
    const m = markersById.get(row.id);
    return {
      id: row.id,
      runtime: row.runtime,
      runtimeSessionId: row.runtime_session_id ?? "",
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMin: row.duration_min,
      label: row.label,
      summary: row.summary,
      status: liveSessionStatus(row.transcript_path, row.status),
      transcriptKind: row.transcript_kind ?? "",
      transcriptPath: row.transcript_path,
      body: row.body ?? "",
      entities: entitiesById.get(row.id) ?? [],
      decisions: m?.decisions ?? [],
      open: m?.open ?? [],
    };
  }
}
