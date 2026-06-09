/**
 * PgSignalStore - SignalStore over pg.Pool. Receives its Pool from PgStorage.
 * Insert is idempotent via ON CONFLICT (id) DO NOTHING.
 */

import type { Pool } from "pg";
import type { SignalAggregationFilter, SignalStore } from "@ports/signal-store.js";
import type { Signal, SignalKind, SignalOutcome } from "@shared/types.js";

type SignalRow = {
  id: string;
  v: number;
  install_scope: string;
  kind: SignalKind;
  producer: string;
  outcome: SignalOutcome;
  model: string;
  repo: string;
  step: string | null;
  detail: string | null;
  session_id: string | null;
  ts: string;
  created_at: string;
};

const SCAN_CAP = 5000;
const INSERT_SQL = `
  INSERT INTO signals (
    id, v, install_scope, kind, producer, outcome, model, repo,
    step, detail, session_id, ts, created_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  ON CONFLICT (id) DO NOTHING`;

function insertParams(s: Signal): unknown[] {
  return [
    s.id, s.v, s.installScope, s.kind, s.producer, s.outcome, s.model, s.repo,
    s.step, s.detail === null ? null : JSON.stringify(s.detail), s.sessionId, s.ts, s.createdAt,
  ];
}

export class PgSignalStore implements SignalStore {
  constructor(private readonly pool: Pool) {}

  async insert(signal: Signal): Promise<void> {
    await this.pool.query(INSERT_SQL, insertParams(signal));
  }

  async insertMany(signals: ReadonlyArray<Signal>): Promise<void> {
    if (signals.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const s of signals) await client.query(INSERT_SQL, insertParams(s));
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listForAggregation(filter: SignalAggregationFilter): Promise<ReadonlyArray<Signal>> {
    const where: string[] = ["install_scope = $1"];
    const params: unknown[] = [filter.installScope];
    let idx = 2;
    if (filter.repo !== undefined) { where.push(`repo = $${idx++}`); params.push(filter.repo); }
    if (filter.model !== undefined) { where.push(`model = $${idx++}`); params.push(filter.model); }
    if (filter.kind !== undefined) { where.push(`kind = $${idx++}`); params.push(filter.kind); }
    if (filter.sinceTs !== undefined) { where.push(`ts >= $${idx++}`); params.push(filter.sinceTs); }
    const limit = Math.max(1, Math.min(SCAN_CAP, Math.trunc(filter.limit ?? SCAN_CAP)));
    params.push(limit);
    const result = await this.pool.query<SignalRow>(
      `SELECT id, v, install_scope, kind, producer, outcome, model, repo,
              step, detail, session_id, ts, created_at
       FROM signals
       WHERE ${where.join(" AND ")}
       ORDER BY ts DESC
       LIMIT $${idx}`,
      params,
    );
    return result.rows.map(rowToSignal);
  }

  async countSince(installScope: string, sinceTs: string): Promise<number> {
    const result = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM signals WHERE install_scope = $1 AND ts >= $2",
      [installScope, sinceTs],
    );
    return Number.parseInt(result.rows[0]?.n ?? "0", 10);
  }

  async pruneOlderThan(olderThanTs: string): Promise<number> {
    const result = await this.pool.query("DELETE FROM signals WHERE ts < $1", [olderThanTs]);
    return result.rowCount ?? 0;
  }
}

function rowToSignal(row: SignalRow): Signal {
  return {
    id: row.id,
    v: row.v,
    installScope: row.install_scope,
    kind: row.kind,
    producer: row.producer,
    outcome: row.outcome,
    model: row.model,
    repo: row.repo,
    step: row.step,
    detail: row.detail === null ? null : (JSON.parse(row.detail) as Record<string, unknown>),
    sessionId: row.session_id,
    ts: row.ts,
    createdAt: row.created_at,
  };
}
