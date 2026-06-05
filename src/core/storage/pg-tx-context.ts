/**
 * PgTxContext — write-queue for PgStorage.withTransaction.
 *
 * PgStorage.withTransaction requires a sync callback (port contract). PG
 * transactions are async. Bridge: sync callback queues SQL ops; PgStorage
 * flushes the queue in one BEGIN/COMMIT after the callback returns.
 *
 * Read methods throw — they cannot see uncommitted queue state. The
 * FactStore/SessionStore contracts never read inside withTransaction.
 */

import type {
  FactListFilter,
  FactQuery,
  FactSemanticNeighbor,
  FactStore,
} from "@ports/fact-store.js";
import type {
  KeywordNeighbor,
  SemanticNeighbor,
  SessionFilter,
  SessionStore,
} from "@ports/session-store.js";
import type { Fact, FactHistoryChain, Session, SessionStatus } from "@shared/types.js";

export interface QueuedOp {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function noRead(method: string): never {
  throw new Error(`PgStorage.withTransaction: ${method} read not supported inside sync callback`);
}

export class PgTxBoundFactStore implements FactStore {
  constructor(private readonly q: QueuedOp[]) {}

  insert(fact: Fact): Promise<void> {
    this.q.push(insertFactOp(fact));
    return Promise.resolve();
  }

  insertMany(facts: ReadonlyArray<Fact>): Promise<void> {
    for (const f of facts) this.q.push(insertFactOp(f));
    return Promise.resolve();
  }

  markSuperseded(oldId: string, newId: string | null): Promise<void> {
    this.q.push({
      sql: "UPDATE facts SET superseded_by = $1 WHERE id = $2",
      params: [newId, oldId],
    });
    return Promise.resolve();
  }

  ingestSessionFacts(sessionId: string, facts: ReadonlyArray<Fact>): Promise<void> {
    this.q.push({
      sql: "DELETE FROM facts WHERE source_session_id = $1",
      params: [sessionId],
    });
    for (const f of facts) this.q.push(insertFactOp(f));
    if (facts.length > 0) {
      const values = facts
        .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
        .join(", ");
      const params: unknown[] = [];
      for (const f of facts) params.push(f.subject, f.predicate, f.id);
      this.q.push({
        sql: `
          UPDATE facts AS old
          SET superseded_by = new_f.new_id
          FROM (VALUES ${values}) AS new_f(subject, predicate, new_id)
          WHERE old.subject = new_f.subject
            AND old.predicate = new_f.predicate
            AND old.superseded_by IS NULL
            AND old.id != new_f.new_id
        `,
        params,
      });
    }
    return Promise.resolve();
  }

  upsertEmbedding(factId: string, vector: Float32Array): Promise<void> {
    this.q.push({
      sql: `
        INSERT INTO fact_embeddings (fact_id, embedding)
        VALUES ($1, $2)
        ON CONFLICT (fact_id) DO UPDATE SET embedding = EXCLUDED.embedding
      `,
      params: [factId, `[${Array.from(vector).join(",")}]`],
    });
    return Promise.resolve();
  }

  getById(_id: string): Promise<Fact | null> { return noRead("FactStore.getById"); }
  findCurrent(_s: string, _p: string): Promise<Fact | null> { return noRead("FactStore.findCurrent"); }
  list(_q: FactQuery): Promise<ReadonlyArray<Fact>> { return noRead("FactStore.list"); }
  listBySession(_id: string): Promise<ReadonlyArray<Fact>> { return noRead("FactStore.listBySession"); }
  listForRecall(_f: FactListFilter): Promise<ReadonlyArray<Fact>> { return noRead("FactStore.listForRecall"); }
  semanticSearch(_v: Float32Array, _n: number): Promise<ReadonlyArray<FactSemanticNeighbor>> { return noRead("FactStore.semanticSearch"); }
  getHistory(_s: string, _p?: string): Promise<ReadonlyArray<FactHistoryChain>> { return noRead("FactStore.getHistory"); }
  corroborationCounts(
    _t: ReadonlyArray<{ subject: string; predicate: string; value: string }>,
  ): Promise<Map<string, number>> {
    return noRead("FactStore.corroborationCounts");
  }
}

export class PgTxBoundSessionStore implements SessionStore {
  constructor(private readonly q: QueuedOp[]) {}

  updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    if (status === "idle") {
      throw new Error("Cannot persist derived status 'idle'");
    }
    this.q.push({
      sql: "UPDATE sessions SET status = $1, updated_at = NOW() WHERE id = $2",
      params: [status, sessionId],
    });
    return Promise.resolve();
  }

  markSuperseded(predecessorId: string, successorId: string): Promise<void> {
    this.q.push({
      sql: `
        INSERT INTO session_edges (from_session, to_session, kind)
        VALUES ($1, $2, 'supersedes')
        ON CONFLICT DO NOTHING
      `,
      params: [successorId, predecessorId],
    });
    this.q.push({
      sql: "UPDATE sessions SET status = 'superseded', updated_at = NOW() WHERE id = $1",
      params: [predecessorId],
    });
    return Promise.resolve();
  }

  list(_filter?: SessionFilter): Promise<ReadonlyArray<Session>> { return noRead("SessionStore.list"); }
  getById(_id: string): Promise<Session | null> { return noRead("SessionStore.getById"); }
  getByIds(_ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>> { return noRead("SessionStore.getByIds"); }
  semanticSearch(_v: Float32Array, _n: number): Promise<ReadonlyArray<SemanticNeighbor>> { return noRead("SessionStore.semanticSearch"); }
  keywordSearch(_q: string, _n: number): Promise<ReadonlyArray<KeywordNeighbor>> { return noRead("SessionStore.keywordSearch"); }
}

function insertFactOp(f: Fact): QueuedOp {
  return {
    sql: `
      INSERT INTO facts (
        id, kind, subject, predicate, value, source_session_id,
        source_quote, created_at, superseded_by, confidence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    params: [
      f.id, f.kind, f.subject, f.predicate, f.value,
      f.sourceSessionId, f.sourceQuote, f.createdAt, f.supersededBy, f.confidence,
    ],
  };
}
