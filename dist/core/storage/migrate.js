/**
 * Migration runner. Reads versioned *.sql files from a directory, applies any
 * whose integer prefix is not yet in schema_migrations, and returns the list
 * of newly applied versions. Idempotent: re-running on an up-to-date database
 * is a no-op. Each migration file is expected to end with its own
 * `INSERT OR IGNORE INTO schema_migrations (...) VALUES (...)`; the runner
 * also defensively upserts the row in case a file forgets.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const FILE_PATTERN = /^(\d+)_([a-z0-9_-]+)\.sql$/i;
export function runMigrations(db, migrationsDir) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
    const applied = new Set(db
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((r) => r.version));
    const files = readdirSync(migrationsDir)
        .filter((f) => FILE_PATTERN.test(f))
        .sort();
    const newlyApplied = [];
    const upsert = db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)");
    for (const file of files) {
        const match = FILE_PATTERN.exec(file);
        if (!match)
            continue;
        const version = Number(match[1]);
        const name = match[2] ?? file;
        if (applied.has(version))
            continue;
        const sql = readFileSync(join(migrationsDir, file), "utf8");
        db.exec("BEGIN");
        try {
            db.exec(sql);
            upsert.run(version, name);
            db.exec("COMMIT");
        }
        catch (err) {
            db.exec("ROLLBACK");
            throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        newlyApplied.push({ version, name });
    }
    return newlyApplied;
}
//# sourceMappingURL=migrate.js.map