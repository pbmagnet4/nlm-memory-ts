/**
 * PgStorage — canonical Storage adapter for PostgreSQL + pgvector.
 *
 * Implements the Storage port (init/close/withTransaction). withTransaction
 * uses the write-queue pattern: the sync callback queues SQL ops, then
 * PgStorage flushes the queue inside a single BEGIN/COMMIT after the
 * callback returns.
 *
 * pgPool() is a deprecated escape hatch for callers not yet ported to the
 * Storage interface. Tracked for removal in #215a (PG branch).
 */

import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage, StorageContext } from "@ports/storage.js";
import { PgFactStore } from "./pg-fact-store.js";
import { PgSessionStore } from "./pg-session-store.js";
import { PgSignalStore } from "./pg-signal-store.js";
import { PgTxBoundFactStore, PgTxBoundSessionStore, type QueuedOp } from "./pg-tx-context.js";

export interface PgStorageOptions {
  readonly connectionString: string;
  readonly migrationsDir: string;
}

export class PgStorage implements Storage {
  readonly facts: PgFactStore;
  readonly sessions: PgSessionStore;
  readonly signals: PgSignalStore;
  private readonly _pool: Pool;
  private readonly _migrationsDir: string;
  // Guards against re-entrant (synchronous) nesting only. Not concurrent-call-safe.
  private inTxn = false;

  private constructor(pool: Pool, migrationsDir: string) {
    this._pool = pool;
    this._migrationsDir = migrationsDir;
    this.facts = new PgFactStore(pool);
    this.sessions = new PgSessionStore(pool);
    this.signals = new PgSignalStore(pool);
  }

  static create(opts: PgStorageOptions): PgStorage {
    const pool = new Pool({ connectionString: opts.connectionString });
    return new PgStorage(pool, opts.migrationsDir);
  }

  async init(): Promise<void> {
    const sql = readFileSync(join(this._migrationsDir, "001_initial.sql"), "utf8");
    await this._pool.query(sql);
  }

  async close(): Promise<void> {
    await this._pool.end();
  }

  async withTransaction<T>(fn: (ctx: StorageContext) => T): Promise<T> {
    if (this.inTxn) {
      throw new Error("PgStorage.withTransaction does not support nesting");
    }
    this.inTxn = true;
    const queue: QueuedOp[] = [];
    const txFacts = new PgTxBoundFactStore(queue);
    const txSessions = new PgTxBoundSessionStore(queue);
    const ctx: StorageContext = { facts: txFacts, sessions: txSessions };
    let result: T;
    try {
      result = fn(ctx);
    } catch (err) {
      this.inTxn = false;
      throw err;
    }
    this.inTxn = false;
    if (queue.length > 0) {
      const client = await this._pool.connect();
      try {
        await client.query("BEGIN");
        for (const op of queue) {
          await client.query(op.sql, op.params as unknown[]);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    return result!;
  }

  /**
   * @deprecated Escape hatch for callers not yet ported to the Storage
   * interface. Tracked for removal in #215a (PG branch).
   */
  pgPool(): Pool {
    return this._pool;
  }
}
