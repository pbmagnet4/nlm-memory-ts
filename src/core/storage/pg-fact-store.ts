/**
 * PgFactStore — FactStore implementation over pg.Pool + pgvector.
 *
 * Receives its Pool from PgStorage. Never opens its own connection.
 */

import type { Pool } from "pg";
import type {
  FactListFilter,
  FactQuery,
  FactSemanticNeighbor,
  FactStore,
} from "@ports/fact-store.js";
import type { Fact, FactHistoryChain, FactKind } from "@shared/types.js";

type FactRow = {
  id: string;
  kind: FactKind;
  subject: string;
  predicate: string;
  value: string;
  source_session_id: string;
  source_quote: string | null;
  created_at: string;
  superseded_by: string | null;
  confidence: number;
};

export class PgFactStore implements FactStore {
  constructor(private readonly pool: Pool) {}

  async insert(fact: Fact): Promise<void> {
    await this.pool.query(
      `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
         source_quote, created_at, superseded_by, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [fact.id, fact.kind, fact.subject, fact.predicate, fact.value,
       fact.sourceSessionId, fact.sourceQuote, fact.createdAt, fact.supersededBy, fact.confidence],
    );
  }

  async insertMany(facts: ReadonlyArray<Fact>): Promise<void> {
    if (facts.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const f of facts) {
        await client.query(
          `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
             source_quote, created_at, superseded_by, confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [f.id, f.kind, f.subject, f.predicate, f.value,
           f.sourceSessionId, f.sourceQuote, f.createdAt, f.supersededBy, f.confidence],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getById(id: string): Promise<Fact | null> {
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence
       FROM facts WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? rowToFact(result.rows[0]) : null;
  }

  async findCurrent(subject: string, predicate: string): Promise<Fact | null> {
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence
       FROM facts
       WHERE subject = $1 AND predicate = $2 AND superseded_by IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [subject, predicate],
    );
    return result.rows[0] ? rowToFact(result.rows[0]) : null;
  }

  async list(query: FactQuery): Promise<ReadonlyArray<Fact>> {
    const limit = Math.max(1, Math.trunc(query.limit ?? 50));
    const includeSuperseded = query.includeSuperseded === true;
    const where: string[] = ["subject = $1"];
    const params: unknown[] = [query.subject];
    let idx = 2;
    if (query.predicate !== undefined) {
      where.push(`predicate = $${idx++}`);
      params.push(query.predicate);
    }
    if (!includeSuperseded) where.push("superseded_by IS NULL");
    params.push(limit);
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence
       FROM facts
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${idx}`,
      params,
    );
    return result.rows.map(rowToFact);
  }

  async listBySession(sessionId: string): Promise<ReadonlyArray<Fact>> {
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence
       FROM facts
       WHERE source_session_id = $1
       ORDER BY created_at ASC`,
      [sessionId],
    );
    return result.rows.map(rowToFact);
  }

  async listForRecall(filter: FactListFilter): Promise<ReadonlyArray<Fact>> {
    const where: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (filter.subject !== undefined) { where.push(`subject = $${idx++}`); params.push(filter.subject); }
    if (filter.predicate !== undefined) { where.push(`predicate = $${idx++}`); params.push(filter.predicate); }
    if (filter.kind !== undefined) { where.push(`kind = $${idx++}`); params.push(filter.kind); }
    if (filter.minConfidence !== undefined) { where.push(`confidence >= $${idx++}`); params.push(filter.minConfidence); }
    if (filter.includeSuperseded !== true) where.push("superseded_by IS NULL");
    const limit = Math.max(1, Math.trunc(filter.limit ?? 500));
    params.push(limit);
    const sql = `
      SELECT id, kind, subject, predicate, value, source_session_id,
             source_quote, created_at, superseded_by, confidence
      FROM facts
      ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `;
    const result = await this.pool.query<FactRow>(sql, params);
    return result.rows.map(rowToFact);
  }

  async markSuperseded(oldId: string, newId: string | null): Promise<void> {
    if (newId !== null && oldId === newId) {
      throw new Error("A fact cannot supersede itself");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const old = await client.query<{ id: string }>(
        "SELECT id FROM facts WHERE id = $1", [oldId],
      );
      if (old.rows.length === 0) throw new Error(`Fact ${oldId} not found`);
      if (newId !== null) {
        const next = await client.query<{ id: string }>(
          "SELECT id FROM facts WHERE id = $1", [newId],
        );
        if (next.rows.length === 0) throw new Error(`Fact ${newId} not found`);
      }
      await client.query(
        "UPDATE facts SET superseded_by = $1 WHERE id = $2", [newId, oldId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async ingestSessionFacts(
    sessionId: string,
    facts: ReadonlyArray<Fact>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM facts WHERE source_session_id = $1", [sessionId]);
      if (facts.length > 0) {
        for (const f of facts) {
          await client.query(
            `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
               source_quote, created_at, superseded_by, confidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [f.id, f.kind, f.subject, f.predicate, f.value,
             f.sourceSessionId, f.sourceQuote, f.createdAt, f.supersededBy, f.confidence],
          );
        }
        const values = facts
          .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
          .join(", ");
        const params: unknown[] = [];
        for (const f of facts) params.push(f.subject, f.predicate, f.id);
        await client.query(
          `UPDATE facts AS old
           SET superseded_by = new_f.new_id
           FROM (VALUES ${values}) AS new_f(subject, predicate, new_id)
           WHERE old.subject = new_f.subject
             AND old.predicate = new_f.predicate
             AND old.superseded_by IS NULL
             AND old.id != new_f.new_id`,
          params,
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertEmbedding(factId: string, vector: Float32Array): Promise<void> {
    const vecStr = `[${Array.from(vector).join(",")}]`;
    await this.pool.query(
      `INSERT INTO fact_embeddings (fact_id, embedding)
       VALUES ($1, $2::vector)
       ON CONFLICT (fact_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [factId, vecStr],
    );
  }

  async semanticSearch(
    queryVector: Float32Array,
    limit: number,
  ): Promise<ReadonlyArray<FactSemanticNeighbor>> {
    const k = Math.max(1, Math.trunc(limit));
    const vecStr = `[${Array.from(queryVector).join(",")}]`;
    const result = await this.pool.query<{ fact_id: string; distance: number }>(
      `SELECT fact_id, embedding <-> $1::vector AS distance
       FROM fact_embeddings
       ORDER BY embedding <-> $1::vector
       LIMIT $2`,
      [vecStr, k],
    );
    return result.rows.map((r) => ({ factId: r.fact_id, distance: r.distance }));
  }

  async getHistory(
    subject: string,
    predicate?: string,
  ): Promise<ReadonlyArray<FactHistoryChain>> {
    const result = predicate
      ? await this.pool.query<FactRow>(
          `SELECT id, kind, subject, predicate, value, source_session_id,
                  source_quote, created_at, superseded_by, confidence
           FROM facts
           WHERE subject = $1 AND predicate = $2
           ORDER BY predicate ASC, created_at DESC`,
          [subject, predicate],
        )
      : await this.pool.query<FactRow>(
          `SELECT id, kind, subject, predicate, value, source_session_id,
                  source_quote, created_at, superseded_by, confidence
           FROM facts
           WHERE subject = $1
           ORDER BY predicate ASC, created_at DESC`,
          [subject],
        );

    const byPred = new Map<string, Fact[]>();
    for (const row of result.rows) {
      const fact = rowToFact(row);
      const bucket = byPred.get(fact.predicate);
      if (bucket) bucket.push(fact);
      else byPred.set(fact.predicate, [fact]);
    }
    return [...byPred.entries()].map(([pred, history]) => ({ subject, predicate: pred, history }));
  }

  async corroborationCounts(
    triples: ReadonlyArray<{
      readonly subject: string;
      readonly predicate: string;
      readonly value: string;
    }>,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (triples.length === 0) return out;

    const values: string[] = [];
    const args: string[] = [];
    for (let i = 0; i < triples.length; i++) {
      const t = triples[i]!;
      const base = i * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      args.push(t.subject, t.predicate, t.value);
    }
    const sql = `
      WITH q(subject, predicate, value) AS (VALUES ${values.join(", ")})
      SELECT q.subject, q.predicate, q.value,
             COUNT(DISTINCT f.source_session_id)::int AS session_count
      FROM q
      LEFT JOIN facts f
        ON f.subject = q.subject
       AND f.predicate = q.predicate
       AND f.value = q.value
      GROUP BY q.subject, q.predicate, q.value
    `;
    const result = await this.pool.query<{
      subject: string;
      predicate: string;
      value: string;
      session_count: number;
    }>(sql, args);
    for (const r of result.rows) {
      out.set(`${r.subject} ${r.predicate} ${r.value}`, r.session_count);
    }
    return out;
  }
}

function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    predicate: row.predicate,
    value: row.value,
    sourceSessionId: row.source_session_id,
    sourceQuote: row.source_quote,
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
    confidence: row.confidence,
  };
}
