/**
 * PgSessionStore — SessionStore implementation over pg.Pool + pgvector.
 *
 * Constructor takes the Pool from PgStorage. Also exposes recentWrites()
 * and recentMarkers() for the /live HTTP endpoints, and insertSession() +
 * insertSessionForTest() for ingest and test seeding.
 */

import type { Pool } from "pg";
import type {
  KeywordNeighbor,
  SemanticNeighbor,
  SessionFilter,
  SessionStore,
} from "@ports/session-store.js";
import type { Session, SessionStatus } from "@shared/types.js";
import type { IngestRecord, RecentMarker, RecentWrite } from "./sqlite-session-store.js";
import { chunkSessionText } from "@core/embedding/chunk-body.js";

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

export class PgSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async list(filter?: SessionFilter): Promise<ReadonlyArray<Session>> {
    const result = await this.pool.query<SessionRow>(
      `SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
              label, summary, status, transcript_kind, transcript_path, body
       FROM sessions ORDER BY started_at ASC`,
    );
    if (result.rows.length === 0) return [];
    const ids = result.rows.map((r) => r.id);
    const [entitiesMap, markersMap] = await Promise.all([
      this.loadEntities(ids),
      this.loadMarkers(ids),
    ]);
    const sessions = result.rows.map((r) => rowToSession(r, entitiesMap, markersMap));
    if (!filter) return sessions;
    return sessions.filter((s) => {
      if (filter.entity !== undefined && !s.entities.includes(filter.entity)) return false;
      if (filter.hasDecisions === true && s.decisions.length === 0) return false;
      if (filter.hasOpenQuestions === true && s.open.length === 0) return false;
      return true;
    });
  }

  async getById(sessionId: string): Promise<Session | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
              label, summary, status, transcript_kind, transcript_path, body
       FROM sessions WHERE id = $1`,
      [sessionId],
    );
    if (!result.rows[0]) return null;
    const [entitiesMap, markersMap, edgesMap] = await Promise.all([
      this.loadEntities([sessionId]),
      this.loadMarkers([sessionId]),
      this.loadEdges([sessionId]),
    ]);
    const edges = edgesMap.get(sessionId);
    return rowToSession(result.rows[0], entitiesMap, markersMap, edges);
  }

  async getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>> {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const result = await this.pool.query<Omit<SessionRow, "body">>(
      `SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
              label, summary, status, transcript_kind, transcript_path
       FROM sessions WHERE id IN (${placeholders})`,
      [...ids],
    );
    if (result.rows.length === 0) return [];
    const foundIds = result.rows.map((r) => r.id);
    const [entitiesMap, markersMap] = await Promise.all([
      this.loadEntities(foundIds),
      this.loadMarkers(foundIds),
    ]);
    return result.rows.map((r) => rowToSession({ ...r, body: null }, entitiesMap, markersMap));
  }

  async semanticSearch(
    queryVector: Float32Array,
    limit: number,
  ): Promise<ReadonlyArray<SemanticNeighbor>> {
    const k = Math.max(1, Math.trunc(limit));
    const vecStr = `[${Array.from(queryVector).join(",")}]`;
    const result = await this.pool.query<{ session_id: string; distance: number }>(
      `SELECT session_id, MIN(embedding <-> $1::vector) AS distance
       FROM session_embedding_chunks
       GROUP BY session_id
       ORDER BY distance
       LIMIT $2`,
      [vecStr, k],
    );
    return result.rows.map((r) => ({ sessionId: r.session_id, distance: r.distance }));
  }

  async keywordSearch(
    query: string,
    limit: number,
  ): Promise<ReadonlyArray<KeywordNeighbor>> {
    if (!query.trim()) return [];
    const k = Math.max(1, Math.trunc(limit));
    const result = await this.pool.query<{ session_id: string; score: number }>(
      `SELECT id AS session_id,
              ts_rank_cd(fts_vector, websearch_to_tsquery('english', $1)) AS score
       FROM sessions
       WHERE fts_vector @@ websearch_to_tsquery('english', $1)
       ORDER BY score DESC
       LIMIT $2`,
      [query, k],
    );
    return result.rows.map((r) => ({ sessionId: r.session_id, score: r.score }));
  }

  async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    if (status === "idle") {
      throw new Error("Cannot persist derived status 'idle' — only active/closed/superseded");
    }
    await this.pool.query(
      "UPDATE sessions SET status = $1, updated_at = NOW() WHERE id = $2",
      [status, sessionId],
    );
  }

  async markSuperseded(predecessorId: string, successorId: string): Promise<void> {
    if (predecessorId === successorId) {
      throw new Error("A session cannot supersede itself");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const predExists = await client.query<{ c: string }>(
        "SELECT COUNT(*) AS c FROM sessions WHERE id = $1", [predecessorId],
      );
      if (Number(predExists.rows[0]?.c) === 0) {
        throw new Error(`predecessor session ${predecessorId} not found`);
      }
      const succExists = await client.query<{ c: string }>(
        "SELECT COUNT(*) AS c FROM sessions WHERE id = $1", [successorId],
      );
      if (Number(succExists.rows[0]?.c) === 0) {
        throw new Error(`successor session ${successorId} not found`);
      }
      // Cycle guard. Edges read (from, to) = "from supersedes to". We are about
      // to insert (successor, predecessor). A cycle closes if the predecessor
      // can already reach the successor by following supersedes edges — then
      // the new edge would loop back. Walk from→to starting at the predecessor.
      const seen = new Set<string>([predecessorId]);
      let frontier = [predecessorId];
      for (let depth = 0; depth < 100 && frontier.length > 0; depth++) {
        const children = await client.query<{ to_session: string }>(
          `SELECT to_session FROM session_edges WHERE from_session = ANY($1) AND kind = 'supersedes'`,
          [frontier],
        );
        const next: string[] = [];
        for (const { to_session } of children.rows) {
          if (to_session === successorId) {
            throw new Error(
              `supersedence cycle: ${successorId} is already (transitively) superseded by ${predecessorId}`,
            );
          }
          if (!seen.has(to_session)) {
            seen.add(to_session);
            next.push(to_session);
          }
        }
        frontier = next;
      }
      await client.query(
        `DELETE FROM session_edges WHERE to_session = $1 AND kind = 'supersedes' AND from_session != $2`,
        [predecessorId, successorId],
      );
      await client.query(
        `INSERT INTO session_edges (from_session, to_session, kind)
         VALUES ($1, $2, 'supersedes')
         ON CONFLICT DO NOTHING`,
        [successorId, predecessorId],
      );
      await client.query(
        "UPDATE sessions SET status = 'superseded', updated_at = NOW() WHERE id = $1",
        [predecessorId],
      );

      // Cascade supersedence to facts in a single correlated UPDATE
      const cascadeSQL = `
        UPDATE facts AS p
        SET superseded_by = (
          SELECT s.id FROM facts s
          WHERE s.source_session_id = $2
            AND s.subject = p.subject
            AND s.predicate = p.predicate
            AND s.superseded_by IS NULL
          LIMIT 1
        )
        WHERE p.source_session_id = $1
          AND EXISTS (
            SELECT 1 FROM facts s
            WHERE s.source_session_id = $2
              AND s.subject = p.subject
              AND s.predicate = p.predicate
              AND s.superseded_by IS NULL
          )
      `;
      await client.query(cascadeSQL, [predecessorId, successorId]);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async recentWrites(limit: number): Promise<RecentWrite[]> {
    const result = await this.pool.query<Omit<RecentWrite, "entities">>(
      `SELECT id, runtime, label, summary, created_at AS "createdAt"
       FROM sessions ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    if (result.rows.length === 0) return [];
    const ids = result.rows.map((r) => r.id);
    const entityResult = await this.pool.query<{ session_id: string; entity_canonical: string }>(
      `SELECT session_id, entity_canonical
       FROM session_entities
       WHERE session_id = ANY($1)
       ORDER BY entity_canonical`,
      [ids],
    );
    const byId = new Map<string, string[]>();
    for (const e of entityResult.rows) {
      const list = byId.get(e.session_id);
      if (list) list.push(e.entity_canonical);
      else byId.set(e.session_id, [e.entity_canonical]);
    }
    return result.rows.map((r) => ({ ...r, entities: byId.get(r.id) ?? [] }));
  }

  async recentMarkers(limit: number): Promise<RecentMarker[]> {
    const result = await this.pool.query<RecentMarker>(
      `SELECT m.session_id AS "sessionId", m.kind, m.text, s.label, s.created_at AS "createdAt"
       FROM markers m
       JOIN sessions s ON s.id = m.session_id
       ORDER BY s.created_at DESC, m.position ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async insertSession(
    record: IngestRecord,
    embedder: import("@ports/llm-client.js").LLMClient | null = null,
    supersedes: string | null = null,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO sessions (
           id, runtime, runtime_session_id, started_at, ended_at, duration_min,
           label, summary, body, status, transcript_kind, transcript_path,
           transcript_offset, transcript_length
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           ended_at = EXCLUDED.ended_at,
           duration_min = EXCLUDED.duration_min,
           label = EXCLUDED.label,
           summary = EXCLUDED.summary,
           body = EXCLUDED.body,
           status = EXCLUDED.status,
           updated_at = NOW()`,
        [
          record.id, record.runtime, record.runtimeSessionId,
          record.startedAt, record.endedAt, record.durationMin,
          record.label, record.summary, record.body,
          record.status === "idle" ? "active" : record.status,
          record.transcriptKind, record.transcriptPath,
          record.transcriptOffset, record.transcriptLength,
        ],
      );
      await client.query("DELETE FROM markers WHERE session_id = $1", [record.id]);
      for (let i = 0; i < record.decisions.length; i++) {
        await client.query(
          "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'decision', $2, $3)",
          [record.id, record.decisions[i]!.trim(), i],
        );
      }
      for (let i = 0; i < record.openQuestions.length; i++) {
        await client.query(
          "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'open', $2, $3)",
          [record.id, record.openQuestions[i]!.trim(), i],
        );
      }
      for (const raw of record.entities) {
        const name = raw.trim();
        if (!name) continue;
        await client.query(
          `INSERT INTO entities (canonical, type, status, source, first_seen_session, last_seen_session, session_count)
           VALUES ($1, 'candidate', 'candidate', 'auto-detected', $2, $2, 0)
           ON CONFLICT (canonical) DO UPDATE SET
             last_seen_session = $2,
             session_count = entities.session_count + 1,
             updated_at = NOW()`,
          [name, record.id],
        );
        await client.query(
          "INSERT INTO session_entities (session_id, entity_canonical) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [record.id, name],
        );
      }
      if (supersedes && supersedes !== record.id) {
        await client.query(
          `INSERT INTO session_edges (from_session, to_session, kind)
           VALUES ($1, $2, 'supersedes') ON CONFLICT DO NOTHING`,
          [record.id, supersedes],
        );
        await client.query(
          "UPDATE sessions SET status = 'superseded', updated_at = NOW() WHERE id = $1",
          [supersedes],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    if (embedder) {
      const chunks = chunkSessionText({ label: record.label, summary: record.summary, body: record.body });
      await this.pool.query("DELETE FROM session_embedding_chunks WHERE session_id = $1", [record.id]);
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const text = chunks[chunkIdx]!;
        if (!text) continue;
        try {
          const { vector } = await embedder.embed(text, "document");
          const vecStr = `[${Array.from(vector).join(",")}]`;
          const ins = await this.pool.query<{ chunk_id: number }>(
            `INSERT INTO session_embedding_chunks (session_id, chunk_idx, embedding)
             VALUES ($1, $2, $3::vector) RETURNING chunk_id`,
            [record.id, chunkIdx, vecStr],
          );
          const chunkId = ins.rows[0]!.chunk_id;
          await this.pool.query(
            "INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES ($1, $2, $3)",
            [chunkId, record.id, chunkIdx],
          );
        } catch (err) {
          process.stderr.write(`[nlm] embedding chunk failed session=${record.id} chunk=${chunkIdx}: ${String(err)}\n`);
        }
      }
    }
  }

  async insertSessionForTest(session: Session): Promise<void> {
    const status: SessionStatus = session.status === "idle" ? "active" : session.status;
    await this.pool.query(
      `INSERT INTO sessions (id, runtime, runtime_session_id, started_at, ended_at,
         duration_min, label, summary, body, status, transcript_kind, transcript_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        session.id, session.runtime, session.runtimeSessionId, session.startedAt,
        session.endedAt, session.durationMin, session.label, session.summary,
        session.body, status, session.transcriptKind, session.transcriptPath,
      ],
    );
    for (const e of session.entities) {
      await this.pool.query(
        "INSERT INTO entities (canonical, type, status) VALUES ($1, 'candidate', 'active') ON CONFLICT DO NOTHING",
        [e],
      );
      await this.pool.query(
        "INSERT INTO session_entities (session_id, entity_canonical) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [session.id, e],
      );
    }
    for (let i = 0; i < session.decisions.length; i++) {
      await this.pool.query(
        "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'decision', $2, $3)",
        [session.id, session.decisions[i], i],
      );
    }
    for (let i = 0; i < session.open.length; i++) {
      await this.pool.query(
        "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'open', $2, $3)",
        [session.id, session.open[i], i],
      );
    }
  }

  private async loadEntities(ids: ReadonlyArray<string>): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const result = await this.pool.query<{ session_id: string; entity_canonical: string }>(
      `SELECT session_id, entity_canonical FROM session_entities
       WHERE session_id IN (${placeholders}) ORDER BY session_id`,
      [...ids],
    );
    const out = new Map<string, string[]>();
    for (const r of result.rows) {
      const list = out.get(r.session_id);
      if (list) list.push(r.entity_canonical);
      else out.set(r.session_id, [r.entity_canonical]);
    }
    return out;
  }

  private async loadMarkers(
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, { decisions: string[]; open: string[] }>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const result = await this.pool.query<{ session_id: string; kind: "decision" | "open"; text: string }>(
      `SELECT session_id, kind, text FROM markers
       WHERE session_id IN (${placeholders}) ORDER BY session_id, position`,
      [...ids],
    );
    const out = new Map<string, { decisions: string[]; open: string[] }>();
    for (const r of result.rows) {
      let bucket = out.get(r.session_id);
      if (!bucket) { bucket = { decisions: [], open: [] }; out.set(r.session_id, bucket); }
      if (r.kind === "decision") bucket.decisions.push(r.text);
      else bucket.open.push(r.text);
    }
    return out;
  }

  private async loadEdges(
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, { supersededBy: string | null; supersedes: string[] }>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const result = await this.pool.query<{ from_session: string; to_session: string }>(
      `SELECT from_session, to_session FROM session_edges
       WHERE kind = 'supersedes'
         AND (from_session IN (${placeholders}) OR to_session IN (${placeholders}))`,
      [...ids, ...ids],
    );
    const out = new Map<string, { supersededBy: string | null; supersedes: string[] }>();
    for (const id of ids) out.set(id, { supersededBy: null, supersedes: [] });
    for (const r of result.rows) {
      out.get(r.from_session)?.supersedes.push(r.to_session);
      const toEntry = out.get(r.to_session);
      if (toEntry) toEntry.supersededBy = r.from_session;
    }
    return out;
  }
}

function rowToSession(
  row: SessionRow,
  entitiesById: Map<string, string[]>,
  markersById: Map<string, { decisions: string[]; open: string[] }>,
  edges?: { supersededBy: string | null; supersedes: string[] },
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
    status: row.status,
    transcriptKind: row.transcript_kind ?? "",
    transcriptPath: row.transcript_path,
    body: row.body ?? "",
    entities: entitiesById.get(row.id) ?? [],
    decisions: m?.decisions ?? [],
    open: m?.open ?? [],
    ...(edges !== undefined
      ? { supersededBy: edges.supersededBy, supersedes: edges.supersedes }
      : {}),
  };
}
