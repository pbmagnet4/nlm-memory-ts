/**
 * SqliteSessionStore.checkpoint — drains the WAL into the main DB and
 * truncates the -wal file, so it cannot grow unbounded.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SqliteSessionStore.checkpoint", () => {
  let tmp: string;
  let dbPath: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-wal-"));
    dbPath = join(tmp, "canonical.sqlite");
    store = new SqliteSessionStore({ dbPath, migrationsDir: MIGRATIONS_DIR });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("truncates the -wal file after checkpoint", () => {
    for (let i = 0; i < 30; i++) {
      store.insertSessionForTest(
        makeSession({ id: `s${i}`, label: `session ${i}`, body: "x".repeat(5000) }),
      );
    }
    const walBefore = statSync(`${dbPath}-wal`).size;
    expect(walBefore).toBeGreaterThan(0);

    store.checkpoint();

    const walAfter = statSync(`${dbPath}-wal`).size;
    expect(walAfter).toBe(0);
  });

  it("is safe to call when the WAL is already empty", () => {
    expect(() => store.checkpoint()).not.toThrow();
  });
});
