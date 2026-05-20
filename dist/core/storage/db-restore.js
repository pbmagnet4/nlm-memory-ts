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
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
export const PENDING_SUFFIX = ".restore-pending";
/**
 * Validate that `filePath` is a usable canonical store: passes integrity
 * check and carries the `sessions` + `schema_migrations` tables. Opened
 * read-only and without the sqlite-vec extension — we never touch the
 * vec virtual tables here, so the extension isn't needed.
 */
export function validateRestoreCandidate(filePath) {
    let db = null;
    try {
        db = new Database(filePath, { readonly: true, fileMustExist: true });
        const integrity = db.pragma("integrity_check", { simple: true });
        if (integrity !== "ok") {
            return { ok: false, error: `integrity check failed: ${String(integrity)}` };
        }
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','schema_migrations')")
            .all()
            .map((r) => r.name);
        if (!tables.includes("sessions") || !tables.includes("schema_migrations")) {
            return { ok: false, error: "not an nlm-memory database (missing sessions/schema_migrations)" };
        }
        const sessions = db
            .prepare("SELECT COUNT(*) AS n FROM sessions")
            .get();
        const version = db
            .prepare("SELECT MAX(version) AS v FROM schema_migrations")
            .get();
        return {
            ok: true,
            sessions: sessions?.n ?? 0,
            schemaVersion: version?.v ?? 0,
        };
    }
    catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    finally {
        db?.close();
    }
}
/**
 * Park an already-written candidate file as the pending restore for
 * `dbPath`. Validates first; on failure the candidate is removed and the
 * validation error returned. On success the candidate is renamed to
 * `<dbPath>.restore-pending` (same directory, so the rename is atomic).
 */
export function stageRestore(dbPath, candidatePath) {
    const validation = validateRestoreCandidate(candidatePath);
    if (!validation.ok) {
        rmSync(candidatePath, { force: true });
        return validation;
    }
    const pending = dbPath + PENDING_SUFFIX;
    rmSync(pending, { force: true });
    renameSync(candidatePath, pending);
    return validation;
}
/**
 * If a pending restore exists for `dbPath`, promote it: move the current
 * DB (and its WAL/SHM sidecars) aside, then rename the pending file into
 * place. Call once at boot, before the store is opened.
 */
export function applyPendingRestore(dbPath) {
    const pending = dbPath + PENDING_SUFFIX;
    if (!existsSync(pending))
        return { applied: false };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archived = `${dbPath}.pre-restore-${stamp}`;
    if (existsSync(dbPath)) {
        renameSync(dbPath, archived);
    }
    // The archived DB's WAL/SHM belong to it — drop the live sidecars so the
    // promoted file isn't paired with a stale WAL.
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        rmSync(sidecar, { force: true });
    }
    renameSync(pending, dbPath);
    return existsSync(archived)
        ? { applied: true, archivedTo: archived }
        : { applied: true };
}
/**
 * Write a live-consistent snapshot of `db` to a fresh file via
 * `VACUUM INTO`. The destination must not already exist. Returns the
 * snapshot's size in bytes.
 */
export function vacuumSnapshot(db, destPath) {
    rmSync(destPath, { force: true });
    db.prepare("VACUUM INTO ?").run(destPath);
    return statSync(destPath).size;
}
/** Scratch path for a backup snapshot, alongside the DB so rename stays atomic. */
export function snapshotScratchPath(dbPath) {
    return join(dirname(dbPath), `.backup-${process.pid}-${Date.now()}.sqlite`);
}
//# sourceMappingURL=db-restore.js.map