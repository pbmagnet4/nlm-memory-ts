/**
 * Task #303 store-layer coverage: keywordSearch / semanticSearch honor the
 * includeSuperseded option, replaced sessions stay excluded regardless, and
 * resolveSuccessors maps a superseded session to its successor.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function unit(values: number[]): Float32Array {
  const padded = new Float32Array(768);
  values.forEach((v, i) => {
    padded[i] = v;
  });
  let sum = 0;
  for (const v of padded) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < padded.length; i++) padded[i] = (padded[i] ?? 0) / norm;
  return padded;
}

describe("SqliteSessionStore include-superseded (#303)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteStorage["sessions"];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-incl-"));
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

  describe("keywordSearch", () => {
    beforeEach(async () => {
      store.insertSessionForTest(
        makeSession({ id: "s_old", label: "elasticsearch indexing", body: "old search backend" }),
      );
      store.insertSessionForTest(
        makeSession({ id: "s_new", label: "elasticsearch migration", body: "new search backend" }),
      );
      store.insertSessionForTest(
        makeSession({ id: "s_repl", label: "elasticsearch dump", body: "mechanical reingest", status: "replaced" }),
      );
      await store.markSuperseded("s_old", "s_new");
    });

    it("excludes superseded by default", async () => {
      const ids = (await store.keywordSearch("elasticsearch", 10)).map((h) => h.sessionId);
      expect(ids).not.toContain("s_old");
      expect(ids).toContain("s_new");
    });

    it("includes superseded when opted in", async () => {
      const ids = (await store.keywordSearch("elasticsearch", 10, { includeSuperseded: true })).map(
        (h) => h.sessionId,
      );
      expect(ids).toContain("s_old");
      expect(ids).toContain("s_new");
    });

    it("never includes replaced, even when including superseded", async () => {
      const ids = (await store.keywordSearch("elasticsearch", 10, { includeSuperseded: true })).map(
        (h) => h.sessionId,
      );
      expect(ids).not.toContain("s_repl");
    });
  });

  describe("semanticSearch", () => {
    beforeEach(async () => {
      store.insertSessionForTest(makeSession({ id: "s_old", label: "old" }));
      store.insertSessionForTest(makeSession({ id: "s_new", label: "new" }));
      store.insertSessionForTest(makeSession({ id: "s_repl", label: "repl", status: "replaced" }));
      store.insertEmbeddingForTest("s_old", unit([1, 0, 0]));
      store.insertEmbeddingForTest("s_new", unit([1, 0.1, 0]));
      store.insertEmbeddingForTest("s_repl", unit([1, 0.05, 0]));
      await store.markSuperseded("s_old", "s_new");
    });

    it("excludes superseded by default", async () => {
      const ids = (await store.semanticSearch(unit([1, 0.05, 0]), 10)).map((r) => r.sessionId);
      expect(ids).not.toContain("s_old");
      expect(ids).toContain("s_new");
    });

    it("includes superseded when opted in", async () => {
      const ids = (await store.semanticSearch(unit([1, 0.05, 0]), 10, { includeSuperseded: true })).map(
        (r) => r.sessionId,
      );
      expect(ids).toContain("s_old");
      expect(ids).toContain("s_new");
    });

    it("never includes replaced, even when including superseded", async () => {
      const ids = (await store.semanticSearch(unit([1, 0.05, 0]), 10, { includeSuperseded: true })).map(
        (r) => r.sessionId,
      );
      expect(ids).not.toContain("s_repl");
    });
  });

  describe("resolveSuccessors", () => {
    it("maps a superseded session to its successor and omits active ids", async () => {
      store.insertSessionForTest(makeSession({ id: "s_old", label: "old" }));
      store.insertSessionForTest(makeSession({ id: "s_new", label: "new" }));
      store.insertSessionForTest(makeSession({ id: "s_active", label: "active" }));
      await store.markSuperseded("s_old", "s_new");

      const map = await store.resolveSuccessors(["s_old", "s_active", "s_new"]);
      expect(map.get("s_old")).toBe("s_new");
      expect(map.has("s_active")).toBe(false);
      expect(map.has("s_new")).toBe(false);
    });

    it("returns an empty map for an empty input", async () => {
      const map = await store.resolveSuccessors([]);
      expect(map.size).toBe(0);
    });
  });
});
