/**
 * SqliteStorage — canonical Storage adapter for better-sqlite3 + sqlite-vec.
 *
 * Owns the connection. Builds SqliteSessionStore and SqliteFactStore over
 * that single connection so writes commit on one WAL writer (the SQLite
 * atomicity model). withTransaction wraps better-sqlite3's synchronous
 * `db.transaction()` API and re-runs it inside an async shell so callers
 * can await async work inside the callback (e.g. an embedder call) — but
 * note that the db txn itself is synchronous; do not call long-running
 * async work inside withTransaction or the txn will hold its write lock.
 *
 * rawDb() is a deprecated escape hatch for callers that still use direct
 * better-sqlite3 — scheduler, http actions endpoints, backfill-facts,
 * source/provider registries. Tracked for removal in #215a.
 */

import type Database from "better-sqlite3";
import type { Storage, StorageContext } from "@ports/storage.js";
import { SqliteFactStore } from "./sqlite-fact-store.js";
import { SqliteSessionStore } from "./sqlite-session-store.js";
import { SqliteSignalStore } from "./sqlite-signal-store.js";

export interface SqliteStorageOptions {
  readonly dbPath: string;
  readonly migrationsDir: string;
}

export class SqliteStorage implements Storage {
  readonly sessions: SqliteSessionStore;
  readonly facts: SqliteFactStore;
  readonly signals: SqliteSignalStore;
  private inTxn = false;

  private constructor(
    sessions: SqliteSessionStore,
    facts: SqliteFactStore,
    signals: SqliteSignalStore,
  ) {
    this.sessions = sessions;
    this.facts = facts;
    this.signals = signals;
  }

  static create(opts: SqliteStorageOptions): SqliteStorage {
    const sessions = new SqliteSessionStore(opts);
    const facts = new SqliteFactStore(sessions.rawDb());
    const signals = new SqliteSignalStore(sessions.rawDb());
    return new SqliteStorage(sessions, facts, signals);
  }

  async init(): Promise<void> {
    // SqliteSessionStore runs migrations in its constructor today; this is
    // a no-op for the SQLite adapter. Reserved for backends (Postgres)
    // that need explicit init.
  }

  async close(): Promise<void> {
    this.sessions.close();
  }

  async withTransaction<T>(
    fn: (ctx: StorageContext) => T,
  ): Promise<T> {
    if (this.inTxn) {
      throw new Error("SqliteStorage.withTransaction does not support nesting");
    }
    this.inTxn = true;
    try {
      let captured: T | undefined;
      const txn = this.sessions.rawDb().transaction(() => {
        const ctx: StorageContext = { facts: this.facts, sessions: this.sessions };
        captured = fn(ctx);
      });
      txn();
      // Cast is safe: a sync throw inside fn propagates out of txn() before we reach here, so the success path always assigned captured.
      return captured as T;
    } finally {
      this.inTxn = false;
    }
  }

  /**
   * @deprecated SQLite-only escape hatch for callers not yet ported to the
   * Storage interface. Tracked for removal in #215a. Do not use in new code.
   */
  rawDb(): Database.Database {
    return this.sessions.rawDb();
  }
}
