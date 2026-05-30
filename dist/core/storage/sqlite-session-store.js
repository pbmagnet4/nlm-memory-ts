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
import { liveSessionStatus } from "./live-status.js";
import { loadActionOverlay, openQuestionId } from "../actions/overlay.js";
import { runMigrations } from "./migrate.js";
import { tokenize } from "../recall/tokenize.js";
import { chunkSessionText } from "../embedding/chunk-body.js";
export class SqliteSessionStore {
    db;
    constructor(opts) {
        const dbPath = resolve(opts.dbPath);
        const parent = dirname(dbPath);
        if (!existsSync(parent))
            mkdirSync(parent, { recursive: true });
        this.db = new Database(dbPath, opts.readonly ? { readonly: true } : {});
        this.db.pragma("foreign_keys = ON");
        this.db.pragma("journal_mode = WAL");
        sqliteVec.load(this.db);
        if (!opts.readonly) {
            runMigrations(this.db, opts.migrationsDir);
        }
    }
    close() {
        this.db.close();
    }
    /**
     * Drains the WAL into the main database and truncates the -wal file.
     * WAL mode is on but nothing else checkpoints, so the file grows
     * unbounded under continuous readers. The daemon calls this on an
     * interval. Synchronous — keep the WAL small so each call is cheap.
     */
    checkpoint() {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
    }
    /** Raw db handle for ingest helpers (Scheduler, scanOnce). Avoid using
     *  directly from the recall path — it bypasses the SessionStore port. */
    rawDb() {
        return this.db;
    }
    /** Recently-written sessions ordered by created_at desc. Powers /live Writes column. */
    recentWrites(limit) {
        return this.db
            .prepare(`SELECT id, runtime, label, summary, created_at AS createdAt
         FROM sessions
         ORDER BY created_at DESC
         LIMIT ?`)
            .all(limit);
    }
    /** Recently-extracted markers ordered by session created_at desc. Powers /live Decisions column. */
    recentMarkers(limit) {
        return this.db
            .prepare(`SELECT m.session_id AS sessionId, m.kind, m.text, s.label, s.created_at AS createdAt
         FROM markers m
         JOIN sessions s ON s.id = m.session_id
         ORDER BY s.created_at DESC, m.position ASC
         LIMIT ?`)
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
    async insertSession(record, embedder = null, supersedes = null, factSink = null) {
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
            const markerStmt = db.prepare("INSERT INTO markers (session_id, kind, text, position) VALUES (?, ?, ?, ?)");
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
            const linkEnt = db.prepare("INSERT OR IGNORE INTO session_entities (session_id, entity_canonical) VALUES (?, ?)");
            for (const raw of record.entities) {
                const name = raw.trim();
                if (!name)
                    continue;
                insertEnt.run(name, record.id, record.id);
                touchEnt.run(record.id, name);
                linkEnt.run(record.id, name);
            }
            if (supersedes) {
                db.prepare(`INSERT OR IGNORE INTO session_edges (from_session, to_session, kind)
           VALUES (?, ?, 'supersedes')`).run(record.id, supersedes);
                db.prepare("UPDATE sessions SET status = 'superseded', updated_at = datetime('now') WHERE id = ?").run(supersedes);
            }
            // Facts ingest is part of the session txn — either both commit or both
            // roll back. On re-ingest (ON CONFLICT updates the session above), we
            // delete prior facts for this source_session_id before re-inserting so
            // the row count matches the latest classifier output. Without this,
            // re-ingest accumulates duplicates.
            //
            // Phase B.4 — deterministic supersedence on (subject, predicate)
            // collision. For each new fact, after insert, look up any OTHER
            // non-superseded fact with the same (subject, predicate). Mark the
            // older one as superseded by the new fact's id. Always-supersede
            // policy applies even when value is unchanged — same-value re-assertion
            // carries new provenance (new source_session_id) and is informative
            // history. See Section 2 of factstore-design.md.
            //
            // Ordering note: insertManyInTxn FIRST so the new fact id exists in
            // facts(id) before any UPDATE sets superseded_by = newId (the FK
            // would reject otherwise). The DELETE above plus the CASCADE-SET-NULL
            // on superseded_by means re-ingest naturally repairs chains: if an
            // earlier ingest of this session superseded a fact from another
            // session, deleting our prior fact unlinks the chain; the loop below
            // re-establishes it with the freshly-inserted row.
            if (factSink !== null) {
                this.applyFactsInTxn(record.id, factSink.factStore, factSink.facts);
            }
        });
        txn();
        // Embedding is best-effort and lives outside the txn so a slow Ollama
        // doesn't block the row commit. Body is chunked into ≤MAX_CHUNK_CHARS
        // windows (see chunk-body.ts) and each chunk embedded independently.
        // Per-chunk embedder failures are tolerated; the chunks that did embed
        // still contribute to recall.
        if (embedder) {
            const chunks = chunkSessionText({
                label: record.label,
                summary: record.summary,
                body: record.body,
            });
            this.deleteSessionChunks(record.id);
            for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
                const text = chunks[chunkIdx];
                if (!text)
                    continue;
                try {
                    const { vector } = await embedder.embed(text, "document");
                    this.insertChunkEmbedding(record.id, chunkIdx, vector);
                }
                catch {
                    // Per-chunk embedder failure must not roll the ingest back or
                    // abort subsequent chunks.
                }
            }
            if (factSink !== null) {
                await this.embedFacts(factSink.factStore, factSink.facts, embedder);
            }
        }
    }
    deleteSessionChunks(sessionId) {
        const db = this.db;
        const rows = db
            .prepare("SELECT chunk_id FROM session_chunk_map WHERE session_id = ?")
            .all(sessionId);
        if (rows.length === 0)
            return;
        const placeholders = rows.map(() => "?").join(",");
        const ids = rows.map((r) => r.chunk_id);
        db.prepare(`DELETE FROM session_embedding_chunks WHERE chunk_id IN (${placeholders})`).run(...ids);
        db.prepare("DELETE FROM session_chunk_map WHERE session_id = ?").run(sessionId);
    }
    insertChunkEmbedding(sessionId, chunkIdx, vector) {
        const db = this.db;
        const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
        // vec0 enforces strict integer typing on aux columns; better-sqlite3 binds
        // JS numbers as FLOAT, so cast chunk_idx via BigInt to bind as INTEGER.
        const idxInt = BigInt(chunkIdx);
        const info = db
            .prepare("INSERT INTO session_embedding_chunks (embedding, session_id, chunk_idx) VALUES (?, ?, ?)")
            .run(blob, sessionId, idxInt);
        const chunkId = Number(info.lastInsertRowid);
        db.prepare("INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES (?, ?, ?)").run(chunkId, sessionId, chunkIdx);
    }
    /**
     * Phase B.5 — backfill entry point. Writes facts (with deterministic
     * supersedence + best-effort embeddings) for an EXISTING session row
     * without touching it. Opens its own transaction; callers must not be
     * inside one. The session row must already exist in `sessions` or the
     * FK on facts.source_session_id rejects.
     *
     * Use this when ingesting facts after the fact — e.g. running the
     * classifier across a historical corpus that predates the B.2 ingest
     * write path. The live ingest path (`insertSession`) keeps using the
     * internal helpers directly so session+facts commit together.
     */
    async insertFactsForSession(sessionId, factStore, facts, embedder = null) {
        const db = this.db;
        const txn = db.transaction(() => {
            this.applyFactsInTxn(sessionId, factStore, facts);
        });
        txn();
        if (embedder) {
            await this.embedFacts(factStore, facts, embedder);
        }
    }
    /**
     * Sync core of the fact-ingest block. Runs inside an EXISTING transaction
     * — opens no txn of its own. Used by both `insertSession` (Phase B.2
     * atomic ingest) and `insertFactsForSession` (Phase B.5 backfill).
     *
     * Behavior (mirrored across both callers):
     *   1. DELETE prior facts attributed to this session (idempotent on
     *      backfill, drops stale rows on re-ingest).
     *   2. Insert all new facts atomically.
     *   3. For each, mark the prior current (subject, predicate) fact as
     *      superseded — Phase B.4 deterministic supersedence policy.
     *
     * Ordering: inserts before updates so the supersedence FK target exists.
     * CASCADE-SET-NULL on `superseded_by` handles chain repair on re-ingest.
     */
    applyFactsInTxn(sessionId, factStore, facts) {
        const db = this.db;
        db.prepare("DELETE FROM facts WHERE source_session_id = ?").run(sessionId);
        factStore.insertManyInTxn(facts);
        if (facts.length === 0)
            return;
        const findCollisionStmt = db.prepare(`
      SELECT id
      FROM facts
      WHERE subject = ?
        AND predicate = ?
        AND superseded_by IS NULL
        AND id != ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
        const markSupersededStmt = db.prepare("UPDATE facts SET superseded_by = ? WHERE id = ?");
        for (const fact of facts) {
            const prior = findCollisionStmt.get(fact.subject, fact.predicate, fact.id);
            if (prior)
                markSupersededStmt.run(fact.id, prior.id);
        }
    }
    /**
     * Best-effort per-fact embedding. Writes `${subject} ${predicate} ${value}`
     * embeddings to fact_embeddings via FactStore.upsertEmbedding. Per-fact
     * failures don't abort the batch, and never affect committed fact rows.
     */
    async embedFacts(factStore, facts, embedder) {
        for (const fact of facts) {
            const factText = `${fact.subject} ${fact.predicate} ${fact.value}`.trim();
            if (!factText)
                continue;
            try {
                const { vector } = await embedder.embed(factText, "document");
                factStore.upsertEmbedding(fact.id, vector);
            }
            catch {
                // Per-fact embedding failure must not abort embedding of subsequent
                // facts. The fact row stays current; semantic recall just misses it
                // until a future re-ingest.
            }
        }
    }
    async list(filter) {
        const rows = this.db
            .prepare(`
        SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
               label, summary, status, transcript_kind, transcript_path, body
        FROM sessions
        ORDER BY started_at ASC
      `)
            .all();
        if (rows.length === 0)
            return [];
        const ids = rows.map((r) => r.id);
        const entitiesByIdMap = this.loadEntities(ids);
        const markersByIdMap = this.loadMarkers(ids);
        const overlay = loadActionOverlay(this.db);
        const sessions = rows.map((r) => this.rowToSession(r, entitiesByIdMap, markersByIdMap, overlay));
        if (!filter)
            return sessions;
        return sessions.filter((s) => {
            if (filter.entity !== undefined && !s.entities.includes(filter.entity)) {
                return false;
            }
            if (filter.hasDecisions === true && s.decisions.length === 0)
                return false;
            if (filter.hasOpenQuestions === true && s.open.length === 0)
                return false;
            return true;
        });
    }
    async getById(sessionId) {
        const row = this.db
            .prepare(`
        SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
               label, summary, status, transcript_kind, transcript_path, body
        FROM sessions
        WHERE id = ?
      `)
            .get(sessionId);
        if (!row)
            return null;
        const entities = this.loadEntities([sessionId]);
        const markers = this.loadMarkers([sessionId]);
        const edges = this.loadSessionEdges([sessionId]);
        const overlay = loadActionOverlay(this.db);
        return this.rowToSession(row, entities, markers, overlay, edges);
    }
    /**
     * Batched session fetch for the recall path. Deliberately omits the
     * `body` column — body is ~48KB/row of session markdown that recall
     * never reads, and SELECTing it for the corpus is what wedged the
     * daemon. Resolved sessions carry `body: ""`.
     */
    async getByIds(ids) {
        if (ids.length === 0)
            return [];
        const placeholders = ids.map(() => "?").join(",");
        const rows = this.db
            .prepare(`
        SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
               label, summary, status, transcript_kind, transcript_path
        FROM sessions
        WHERE id IN (${placeholders})
      `)
            .all(...ids);
        if (rows.length === 0)
            return [];
        const foundIds = rows.map((r) => r.id);
        const entitiesByIdMap = this.loadEntities(foundIds);
        const markersByIdMap = this.loadMarkers(foundIds);
        const overlay = loadActionOverlay(this.db);
        return rows.map((r) => this.rowToSession({ ...r, body: null }, entitiesByIdMap, markersByIdMap, overlay));
    }
    async semanticSearch(queryVector, limit) {
        const k = Math.max(1, Math.trunc(limit));
        const blob = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
        // Overfetch chunks so the max-pool grouping has enough unique sessions
        // even when several top chunks come from the same session. Default 4
        // ≈ average chunks per session on the LongMemEval-S benchmark. Env-
        // tunable via NLM_CHUNK_OVERFETCH for per-type ablation against the
        // preference/assistant regressions where displacement is hypothesized.
        const envOverfetch = Number.parseInt(process.env["NLM_CHUNK_OVERFETCH"] ?? "", 10);
        const CHUNK_OVERFETCH = Number.isFinite(envOverfetch) && envOverfetch > 0 ? envOverfetch : 4;
        const chunkK = k * CHUNK_OVERFETCH;
        const rows = this.db
            .prepare(`
        SELECT session_id, distance
        FROM session_embedding_chunks
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `)
            .all(blob, chunkK);
        // Max-pool: keep the smallest distance (highest cosine) per session.
        const best = new Map();
        for (const r of rows) {
            const cur = best.get(r.session_id);
            if (cur === undefined || r.distance < cur) {
                best.set(r.session_id, r.distance);
            }
        }
        return [...best.entries()]
            .map(([sessionId, distance]) => ({ sessionId, distance }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, k);
    }
    /**
     * Lexical recall via the sessions_fts FTS5 index. BM25 column weights
     * favour label over summary over body. Returns sessions ranked best-first
     * with a positive score (the negated bm25() value — bm25 is more negative
     * for better matches). User input is tokenized and rebuilt into a quoted
     * OR query so FTS5 metacharacters cannot reach the MATCH parser.
     */
    async keywordSearch(query, limit) {
        const matchExpr = toMatchExpression(query);
        if (!matchExpr)
            return [];
        const k = Math.max(1, Math.trunc(limit));
        const rows = this.db
            .prepare(`
        SELECT s.id AS session_id,
               -bm25(sessions_fts, 10.0, 4.0, 1.0) AS score
        FROM sessions_fts
        JOIN sessions s ON s.rowid = sessions_fts.rowid
        WHERE sessions_fts MATCH ?
        ORDER BY score DESC
        LIMIT ?
      `)
            .all(matchExpr, k);
        return rows.map((r) => ({ sessionId: r.session_id, score: r.score }));
    }
    async updateStatus(sessionId, status) {
        if (status === "idle") {
            throw new Error("Cannot persist derived status 'idle' — only active/closed/superseded");
        }
        this.db
            .prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?")
            .run(status, sessionId);
    }
    async markSuperseded(predecessorId, successorId) {
        if (predecessorId === successorId) {
            throw new Error("A session cannot supersede itself");
        }
        const existsStmt = this.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE id = ?");
        const txn = this.db.transaction(() => {
            const predExists = (existsStmt.get(predecessorId)?.c ?? 0) > 0;
            if (!predExists) {
                throw new Error(`predecessor session ${predecessorId} not found`);
            }
            const succExists = (existsStmt.get(successorId)?.c ?? 0) > 0;
            if (!succExists) {
                throw new Error(`successor session ${successorId} not found`);
            }
            this.db
                .prepare(`INSERT OR IGNORE INTO session_edges (from_session, to_session, kind)
           VALUES (?, ?, 'supersedes')`)
                .run(successorId, predecessorId);
            this.db
                .prepare("UPDATE sessions SET status = 'superseded', updated_at = datetime('now') WHERE id = ?")
                .run(predecessorId);
        });
        txn();
    }
    // ── insert helpers used by tests / future ingest path ─────────────────
    insertSessionForTest(session) {
        const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, runtime, runtime_session_id, started_at, ended_at, duration_min,
        label, summary, body, status, transcript_kind, transcript_path
      ) VALUES (
        @id, @runtime, @runtimeSessionId, @startedAt, @endedAt, @durationMin,
        @label, @summary, @body, @status, @transcriptKind, @transcriptPath
      )
    `);
        const status = session.status === "idle" ? "active" : session.status;
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
        const linkStmt = this.db.prepare("INSERT OR IGNORE INTO session_entities (session_id, entity_canonical) VALUES (?, ?)");
        for (const e of session.entities) {
            entStmt.run(e);
            linkStmt.run(session.id, e);
        }
        const markerStmt = this.db.prepare("INSERT INTO markers (session_id, kind, text, position) VALUES (?, ?, ?, ?)");
        session.decisions.forEach((d, i) => markerStmt.run(session.id, "decision", d, i));
        session.open.forEach((q, i) => markerStmt.run(session.id, "open", q, i));
    }
    insertEdgeForTest(fromSession, toSession, kind = "supersedes") {
        this.db
            .prepare("INSERT OR IGNORE INTO session_edges (from_session, to_session, kind) VALUES (?, ?, ?)")
            .run(fromSession, toSession, kind);
    }
    insertEmbeddingForTest(sessionId, vector) {
        this.insertChunkEmbeddingForTest(sessionId, 0, vector);
    }
    insertChunkEmbeddingForTest(sessionId, chunkIdx, vector) {
        this.insertChunkEmbedding(sessionId, chunkIdx, vector);
    }
    // ── internal ──────────────────────────────────────────────────────────
    loadEntities(ids) {
        if (ids.length === 0)
            return new Map();
        const placeholders = ids.map(() => "?").join(",");
        const rows = this.db
            .prepare(`
        SELECT session_id, entity_canonical
        FROM session_entities
        WHERE session_id IN (${placeholders})
        ORDER BY session_id
      `)
            .all(...ids);
        const out = new Map();
        for (const r of rows) {
            const list = out.get(r.session_id);
            if (list)
                list.push(r.entity_canonical);
            else
                out.set(r.session_id, [r.entity_canonical]);
        }
        return out;
    }
    loadSessionEdges(ids) {
        if (ids.length === 0)
            return new Map();
        const placeholders = ids.map(() => "?").join(",");
        const rows = this.db
            .prepare(`
        SELECT from_session, to_session
        FROM session_edges
        WHERE kind = 'supersedes'
          AND (from_session IN (${placeholders}) OR to_session IN (${placeholders}))
      `)
            .all(...ids, ...ids);
        const out = new Map();
        for (const id of ids) {
            out.set(id, { supersededBy: null, supersedes: [] });
        }
        for (const r of rows) {
            const fromEntry = out.get(r.from_session);
            if (fromEntry)
                fromEntry.supersedes.push(r.to_session);
            const toEntry = out.get(r.to_session);
            if (toEntry)
                toEntry.supersededBy = r.from_session;
        }
        return out;
    }
    loadMarkers(ids) {
        if (ids.length === 0)
            return new Map();
        const placeholders = ids.map(() => "?").join(",");
        const rows = this.db
            .prepare(`
        SELECT session_id, kind, text
        FROM markers
        WHERE session_id IN (${placeholders})
        ORDER BY session_id, position
      `)
            .all(...ids);
        const out = new Map();
        for (const r of rows) {
            let bucket = out.get(r.session_id);
            if (!bucket) {
                bucket = { decisions: [], open: [] };
                out.set(r.session_id, bucket);
            }
            if (r.kind === "decision")
                bucket.decisions.push(r.text);
            else
                bucket.open.push(r.text);
        }
        return out;
    }
    rowToSession(row, entitiesById, markersById, overlay, edgesById) {
        const m = markersById.get(row.id);
        const rawDecisions = m?.decisions ?? [];
        const rawOpen = m?.open ?? [];
        const activeOpen = [];
        const promotedDecisions = [];
        for (const text of rawOpen) {
            const id = openQuestionId(row.id, text);
            if (overlay.resolvedOpens.has(id))
                continue;
            const resolution = overlay.promotedOpens.get(id);
            if (resolution !== undefined) {
                promotedDecisions.push(resolution);
                continue;
            }
            activeOpen.push(text);
        }
        const edges = edgesById?.get(row.id);
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
            ...(edges !== undefined
                ? { supersededBy: edges.supersededBy, supersedes: edges.supersedes }
                : {}),
        };
    }
}
/**
 * Builds a safe FTS5 MATCH expression from raw user input. Each indexable
 * token becomes a double-quoted string literal; literals are OR-joined.
 * Quoting neutralizes FTS5 operators (AND, OR, NEAR, *, parentheses, colon).
 * Returns null when the query has no indexable tokens.
 */
function toMatchExpression(query) {
    const terms = tokenize(query);
    if (terms.length === 0)
        return null;
    return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
//# sourceMappingURL=sqlite-session-store.js.map