/**
 * Migration 019: reclassifies same-transcript_path 'supersedes' edges to
 * 'replaces' (and their predecessor rows to 'replaced'), while leaving
 * cross-path operator supersedences untouched. Seeds both shapes on the
 * migrated schema and asserts the conversion. See
 * docs/plans/2026-06-10-supersedence-split.md.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { runMigrations } from "../../src/core/storage/migrate.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("migration 019 — split replaces from supersedes", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-split-mig-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("same-path edge converts to replaces; cross-path edge survives as supersedes", () => {
    const db = store.rawDb();

    // Mechanical pair: same transcript_path → should convert to replaces.
    store.insertSessionForTest(
      makeSession({ id: "m_old", status: "superseded", transcriptPath: "/t/grown.jsonl" }),
    );
    store.insertSessionForTest(
      makeSession({ id: "m_new", transcriptPath: "/t/grown.jsonl" }),
    );
    db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
      .run("m_new", "m_old");

    // Operator pair: different transcript_path → should stay supersedes/superseded.
    store.insertSessionForTest(
      makeSession({ id: "o_old", status: "superseded", transcriptPath: "/t/old.jsonl" }),
    );
    store.insertSessionForTest(
      makeSession({ id: "o_new", transcriptPath: "/t/new.jsonl" }),
    );
    db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
      .run("o_new", "o_old");

    // Simulate the pre-019 state: roll back the schema_migrations marker so the
    // runner re-applies 019 against this seeded data. (insertSessionForTest used
    // the already-migrated schema, which is fine — 019 is a data reclassification
    // plus an idempotent CHECK widen.)
    db.prepare("DELETE FROM schema_migrations WHERE version = 19").run();
    runMigrations(db, MIGRATIONS_DIR);

    const kindOf = (from: string, to: string) =>
      db.prepare<[string, string], { kind: string }>(
        "SELECT kind FROM session_edges WHERE from_session = ? AND to_session = ?",
      ).get(from, to)?.kind;
    const statusOf = (id: string) =>
      db.prepare<[string], { status: string }>("SELECT status FROM sessions WHERE id = ?")
        .get(id)?.status;

    expect(kindOf("m_new", "m_old")).toBe("replaces");
    expect(statusOf("m_old")).toBe("replaced");

    expect(kindOf("o_new", "o_old")).toBe("supersedes");
    expect(statusOf("o_old")).toBe("superseded");
  });
});
