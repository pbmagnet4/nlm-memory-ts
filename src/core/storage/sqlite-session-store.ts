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
import { loadActionOverlay, openQuestionId } from "@core/actions/overlay.js";
import type { ActionOverlay } from "@core/actions/overlay.js";
import type { Fact } from "@shared/types.js";
import { runMigrations } from "./migrate.js";
import type { SqliteFactStore } from "./sqlite-fact-store.js";

export interface SqliteSessionStoreOptions {
  readonly dbPath: string;
  readonly migrationsDir: string;
  readonly readonly?: boolean;
}

/** Full ingest payload for SqliteSessionStore.insertSession. */
export interface IngestRecord {
  readonly id: string;
  readonly runtime: string;
  readonly runtimeSessionId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMin: number | null;
  readonly label: string;
  readonly summary: string;
  readonly body: string | null;
  readonly status: SessionStatus;
  readonly transcriptKind: string | null;
  readonly transcriptPath: string | null;
  readonly transcriptOffset: number | null;
  readonly transcriptLength: number | null;
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly openQuestions: ReadonlyArray<string>;
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

export interface RecentWrite {
  id: string;
  runtime: string;
  label: string;
  summary: string;
  createdAt: string;
}

export interface RecentMarker {
  sessionId: string;
  kind: "decision" | "open";
  text: string;
  label: string;
  createdAt: string;
}

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

  /** Raw db handle for ingest helpers (Scheduler, scanOnce). Avoid using
   *  directly from the recall path — it bypasses the SessionStore port. */
  rawDb(): Database.Database {
    return this.db;
  }

  /** Recently-written sessions ordered by created_at desc. Powers /live Writes column. */
  recentWrites(limit: number): RecentWrite[] {
    return this.db
      .prepare<[number], RecentWrite>(
        `SELECT id, runtime, label, summary, created_at AS createdAt
         FROM sessions
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit);
  }

  /** Recently-extracted markers ordered by session created_at desc. Powers /live Decisions column. */
  recentMarkers(limit: number): RecentMarker[] {
    return this.db
      .prepare<[number], RecentMarker>(
        `SELECT m.session_id AS sessionId, m.kind, m.text, s.label, s.created_at AS createdAt
         FROM markers m
         JOIN sessions s ON s.id = m.session_id
         ORDER BY s.created_at DESC, m.position ASC
         LIMIT ?`,
      )
      .all(limit);
  }

  /**
   * Atomic ingest: writes the session row, markers, entity rows + links,
   * supersedes edge (if any), and the embedding (best-effort) in one
   * transaction. Idempotent on re-ingest — ON CONFLICT updates the session
   * in place; markers are deleted and rewritten; entity links use INSERT OR
   * IGNORE; embedding row is DELETE+INSERT (vec0 doesn't UPDATE).
   *
   * Mirrors Python's SQLiteStore.insert_session. Markdown projection is not
   * yet ported and skipped here.
   */
  async insertSession(
    record: IngestRecord,
    embedder: import("@ports/llm-client.js").LLMClient | null = null,
    supersedes: string | null = null,
    factSink: { factStore: SqliteFactStore; facts: ReadonlyArray<Fact> } | null = null,
  ): Promise<void> {
    const db = this.db;
    const txn = db.transaction(() => {
      db.prepare(`
        INSERT INTO sessions (
          id, runtime, runtime_session_id, started_at, ended_at, duration_min,
          label, summary, body, status,
          transcript_kind, transcript_path, transcript_offset, transcript_length
        ) VALUES (@id, @runtime, @runtimeSessionId, @startedAt, @endedAt, @durationMin,
          @label, @summary, @body, @status,
          @transcriptKind, @transcriptPath, @transcriptOffset, @transcriptLength)
        ON CONFLICT(id) DO UPDATE SET
          ended_at = excluded.ended_at,
          duration_min = excluded.duration_min,
          label = excluded.label,
          summary = excluded.summary,
          body = excluded.body,
          status = excluded.status,
          updated_at = datetime('now')
      `).run({
        id: record.id,
        runtime: record.runtime,
        runtimeSessionId: record.runtimeSessionId,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        durationMin: record.durationMin,
        label: record.label,
        summary: record.summary,
        body: record.body,
        status: record.status === "idle" ? "active" : record.status,
        transcriptKind: record.transcriptKind,
        transcriptPath: record.transcriptPath,
        transcriptOffset: record.transcriptOffset,
        transcriptLength: record.transcriptLength,
      });

      db.prepare("DELETE FROM markers WHERE session_id = ?").run(record.id);
      const markerStmt = db.prepare(
        "INSERT INTO markers (session_id, kind, text, position) VALUES (?, ?, ?, ?)",
      );
      record.decisions.forEach((d, i) => markerStmt.run(record.id, "decision", d.trim(), i));
      record.openQuestions.forEach((q, i) => markerStmt.run(record.id, "open", q.trim(), i));

      const insertEnt = db.prepare(`
        INSERT OR IGNORE INTO entities
          (canonical, type, status, source, first_seen_session, last_seen_session, session_count)
        VALUES (?, 'candidate', 'candidate', 'auto-detected', ?, ?, 0)
      `);
      const touchEnt = db.prepare(`
        UPDATE entities
        SET last_seen_session = ?, session_count = session_count + 1, updated_at = datetime('now')
        WHERE canonical = ?
      `);
      const linkEnt = db.prepare(
        "INSERT OR IGNORE INTO session_entities (session_id, entity_canonical) VALUES (?, ?)",
      );
      for (const raw of record.entities) {
        const name = raw.trim();
        if (!name) continue;
        insertEnt.run(name, record.id, record.id);
        touchEnt.run(record.id, name);
        linkEnt.run(record.id, name);
      }

      if (supersedes) {
        db.prepare(
          `INSERT OR IGNORE INTO session_edges (from_session, to_session, kind)
           VALUES (?, ?, 'supersedes')`,
        ).run(record.id, supersedes);
        db.prepare(
          "UPDATE sessions SET status = 'superseded', updated_at = datetime('now') WHERE id = ?",
        ).run(supersedes);
      }

      // Facts ingest is part of the session txn — either both commit or both
      // roll back. Phase B.4 will add deterministic supersedence here; for
      // B.2 it's a straight insertMany. On re-ingest (ON CONFLICT updates the
      // session above), we delete prior facts for this source_session_id
      // before re-inserting so the row count matches the latest classifier
      // output. Without this, re-ingest accumulates duplicates.
      if (factSink !== null) {
        db.prepare("DELETE FROM facts WHERE source_session_id = ?").run(record.id);
        factSink.factStore.insertManyInTxn(factSink.facts);
      }
    });
    txn();

    // Embedding is best-effort and lives outside the txn so a slow Ollama
    // doesn't block the row commit.
    if (embedder) {
      const text = [
        record.label,
        record.summary,
        (record.body ?? "").slice(0, 4_000),
      ].filter((s) => s && s.length > 0).join(" ").trim();
      if (text) {
        try {
          const { vector } = await embedder.embed(text, "document");
          const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
          db.prepare("DELETE FROM session_embeddings WHERE session_id = ?").run(record.id);
          db.prepare(
            "INSERT INTO session_embeddings (session_id, embedding) VALUES (?, ?)",
          ).run(record.id, blob);
        } catch {
          // Embedder failure must not roll the ingest back.
        }
      }

      // Fact embeddings — one per fact, best-effort. Cost is N round trips
      // to Ollama; future optimization could batch via the embedder's batch
      // endpoint when sessions average more than a handful of facts. For now
      // the per-fact cost (~50ms) is acceptable relative to the classifier
      // call (~3-8s) that produced them.
      if (factSink !== null) {
        for (const fact of factSink.facts) {
          const factText = `${fact.subject} ${fact.predicate} ${fact.value}`.trim();
          if (!factText) continue;
          try {
            const { vector } = await embedder.embed(factText, "document");
            factSink.factStore.upsertEmbedding(fact.id, vector);
          } catch {
            // Per-fact embedding failure must not roll the ingest back, and
            // must not abort embedding of subsequent facts.
          }
        }
      }
    }
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
    const overlay = loadActionOverlay(this.db);

    const sessions = rows.map((r) => this.rowToSession(r, entitiesByIdMap, markersByIdMap, overlay));

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
    const overlay = loadActionOverlay(this.db);
    return this.rowToSession(row, entities, markers, overlay);
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
    overlay: ActionOverlay,
  ): Session {
    const m = markersById.get(row.id);
    const rawDecisions = m?.decisions ?? [];
    const rawOpen = m?.open ?? [];
    const activeOpen: string[] = [];
    const promotedDecisions: string[] = [];
    for (const text of rawOpen) {
      const id = openQuestionId(row.id, text);
      if (overlay.resolvedOpens.has(id)) continue;
      const resolution = overlay.promotedOpens.get(id);
      if (resolution !== undefined) {
        promotedDecisions.push(resolution);
        continue;
      }
      activeOpen.push(text);
    }
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
      decisions: [...rawDecisions, ...promotedDecisions],
      open: activeOpen,
    };
  }
}
