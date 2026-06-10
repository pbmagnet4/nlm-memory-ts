/**
 * Migration runner. Reads versioned *.sql files from a directory, applies any
 * whose integer prefix is not yet in schema_migrations, and returns the list
 * of newly applied versions. Idempotent: re-running on an up-to-date database
 * is a no-op. Each migration file is expected to end with its own
 * `INSERT OR IGNORE INTO schema_migrations (...) VALUES (...)`; the runner
 * also defensively upserts the row in case a file forgets.
 *
 * A migration whose first line is `-- nlm:no-wrap` is executed without the
 * runner's BEGIN/COMMIT wrapper — it manages its own transaction(s). Required
 * for CHECK-constraint changes, which need a table rebuild under
 * `PRAGMA foreign_keys=OFF` (the pragma is a no-op inside a transaction).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
}

const FILE_PATTERN = /^(\d+)_([a-z0-9_-]+)\.sql$/i;

export function runMigrations(
  db: Database.Database,
  migrationsDir: string,
): ReadonlyArray<AppliedMigration> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set<number>(
    db
      .prepare<[], { version: number }>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => FILE_PATTERN.test(f))
    .sort();

  const newlyApplied: AppliedMigration[] = [];
  const upsert = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match) continue;
    const version = Number(match[1]);
    const name = match[2] ?? file;
    if (applied.has(version)) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf8");
    if (sql.startsWith("-- nlm:no-wrap")) {
      try {
        db.exec(sql);
        upsert.run(version, name);
      } catch (err) {
        throw new Error(
          `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      db.exec("BEGIN");
      try {
        db.exec(sql);
        upsert.run(version, name);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw new Error(
          `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    newlyApplied.push({ version, name });
  }

  return newlyApplied;
}
