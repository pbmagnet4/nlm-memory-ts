/**
 * SQLite-specific assertions that poke rawDb() to inspect internal state.
 *
 * These are NOT part of the FactStore contract. They verify SQLite-only
 * invariants (row counts in fact_embeddings) that a Postgres adapter would
 * verify against pg_class / its own embedding table, not against this code.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SqliteFactStore (SQLite-internal)", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-facts-internal-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    storage.sessions.insertSessionForTest(
      makeSession({ id: "sess_parent", label: "Parent session" }),
    );
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("upsertEmbedding replaces, not duplicates", async () => {
    await storage.facts.insert(makeFact({ id: "f1", sourceSessionId: "sess_parent" }));
    const v1 = new Float32Array(768);
    v1[0] = 1;
    const v2 = new Float32Array(768);
    v2[1] = 1;
    await storage.facts.upsertEmbedding("f1", v1);
    await storage.facts.upsertEmbedding("f1", v2);
    const count = storage
      .rawDb()
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM fact_embeddings WHERE fact_id = 'f1'",
      )
      .get();
    expect(count?.c).toBe(1);
  });
});
