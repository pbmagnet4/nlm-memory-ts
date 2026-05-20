/**
 * Verifies the sessions_fts FTS5 index is present and kept in sync with the
 * sessions table after migrations run and rows are inserted.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("sessions_fts index", () => {
  let tmp: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-fts-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("populates sessions_fts via triggers on insert", () => {
    store.insertSessionForTest(makeSession({ id: "s1", label: "alpha", body: "beta" }));
    store.insertSessionForTest(makeSession({ id: "s2", label: "gamma", body: "delta" }));
    const db = store.rawDb();
    const fts = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM sessions_fts").get();
    const rows = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM sessions").get();
    expect(fts?.n).toBe(rows?.n);
    expect(fts?.n).toBe(2);
  });

  it("records the 008 fts_rebuild migration as applied", () => {
    const db = store.rawDb();
    const row = db
      .prepare<[number], { name: string }>("SELECT name FROM schema_migrations WHERE version = ?")
      .get(8);
    expect(row?.name).toBe("fts_rebuild");
  });

  it("answers a raw FTS5 MATCH query", () => {
    store.insertSessionForTest(makeSession({ id: "s1", label: "pgvector plan", body: "" }));
    const db = store.rawDb();
    const hit = db
      .prepare<[string], { id: string }>(
        "SELECT s.id FROM sessions_fts JOIN sessions s ON s.rowid = sessions_fts.rowid WHERE sessions_fts MATCH ?",
      )
      .get('"pgvector"');
    expect(hit?.id).toBe("s1");
  });
});
