/**
 * Backup + restore for the canonical SQLite store.
 *
 * Backup is live-safe: `VACUUM INTO` takes a read lock and writes a clean,
 * defragmented, single-file snapshot — no WAL sidecars, consistent even
 * while the daemon is ingesting.
 *
 * Restore cannot swap a file the daemon holds open. Instead the uploaded
 * DB is validated and parked at `<dbPath>.restore-pending`; the next daemon
 * boot calls `applyPendingRestore()` before opening the store, moving the
 * current DB aside to `<dbPath>.pre-restore-<ts>` and promoting the pending
 * file. The desktop shell turns "restart required" into one click.
 */
import Database from "better-sqlite3";
export declare const PENDING_SUFFIX = ".restore-pending";
export interface RestoreValidation {
    ok: boolean;
    error?: string;
    sessions?: number;
    schemaVersion?: number;
}
/**
 * Validate that `filePath` is a usable canonical store: passes integrity
 * check and carries the `sessions` + `schema_migrations` tables. Opened
 * read-only and without the sqlite-vec extension — we never touch the
 * vec virtual tables here, so the extension isn't needed.
 */
export declare function validateRestoreCandidate(filePath: string): RestoreValidation;
/**
 * Park an already-written candidate file as the pending restore for
 * `dbPath`. Validates first; on failure the candidate is removed and the
 * validation error returned. On success the candidate is renamed to
 * `<dbPath>.restore-pending` (same directory, so the rename is atomic).
 */
export declare function stageRestore(dbPath: string, candidatePath: string): RestoreValidation;
export interface PendingRestoreResult {
    applied: boolean;
    archivedTo?: string;
}
/**
 * If a pending restore exists for `dbPath`, promote it: move the current
 * DB (and its WAL/SHM sidecars) aside, then rename the pending file into
 * place. Call once at boot, before the store is opened.
 */
export declare function applyPendingRestore(dbPath: string): PendingRestoreResult;
/**
 * Write a live-consistent snapshot of `db` to a fresh file via
 * `VACUUM INTO`. The destination must not already exist. Returns the
 * snapshot's size in bytes.
 */
export declare function vacuumSnapshot(db: Database.Database, destPath: string): number;
/** Scratch path for a backup snapshot, alongside the DB so rename stays atomic. */
export declare function snapshotScratchPath(dbPath: string): string;
