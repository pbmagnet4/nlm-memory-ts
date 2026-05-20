/**
 * Migration runner. Reads versioned *.sql files from a directory, applies any
 * whose integer prefix is not yet in schema_migrations, and returns the list
 * of newly applied versions. Idempotent: re-running on an up-to-date database
 * is a no-op. Each migration file is expected to end with its own
 * `INSERT OR IGNORE INTO schema_migrations (...) VALUES (...)`; the runner
 * also defensively upserts the row in case a file forgets.
 */
import type Database from "better-sqlite3";
export interface AppliedMigration {
    readonly version: number;
    readonly name: string;
}
export declare function runMigrations(db: Database.Database, migrationsDir: string): ReadonlyArray<AppliedMigration>;
