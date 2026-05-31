/**
 * Storage — top-level handle for NLM's fact + session corpus. Owns lifecycle
 * (init/close) and the atomic unit-of-work primitive (withTransaction).
 *
 * Read paths use the bare .facts / .sessions handles. Writes that must
 * commit together — session+facts+embeddings on ingest, supersedence chain
 * edits — go through withTransaction so the adapter chooses its own
 * atomicity mechanism (single SQLite connection, PG transaction, etc.)
 * without core/ knowing which backend it's talking to.
 *
 * See docs/plans/2026-05-30-factstore-storage-port.md.
 */

import type { FactStore } from "./fact-store.js";
import type { SessionStore } from "./session-store.js";

export interface StorageContext {
  readonly facts: FactStore;
  readonly sessions: SessionStore;
}

export interface Storage {
  readonly facts: FactStore;
  readonly sessions: SessionStore;

  /**
   * Run `fn` inside an adapter-defined transaction. The handles on the
   * provided StorageContext are bound to that transaction; reads and writes
   * through them see one another, and either all commit or all roll back.
   * Outer handles (storage.facts, storage.sessions) MUST NOT be used inside
   * `fn`; adapters may enforce this with a runtime check.
   *
   * Callbacks MUST be synchronous. Async work (embedder calls, network I/O)
   * runs BEFORE or AFTER withTransaction, not inside. The SQLite adapter
   * enforces this constraint structurally (better-sqlite3 transactions are
   * synchronous); the Postgres adapter will honor the same shape by
   * batching sync operations into a single async txn. This keeps the
   * port honest across backends and matches the established pattern in
   * SqliteSessionStore.insertSession where embedding work lives outside
   * the transaction.
   *
   * Nested calls are not supported. Adapters throw on nested invocation.
   */
  withTransaction<T>(fn: (ctx: StorageContext) => T): Promise<T>;

  /** Apply migrations / install extensions. Idempotent. */
  init(): Promise<void>;

  /** Release the underlying connection or pool. */
  close(): Promise<void>;
}
