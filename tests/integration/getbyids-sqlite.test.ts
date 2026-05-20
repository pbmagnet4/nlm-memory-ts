/**
 * SqliteSessionStore.getByIds — batched, body-free session fetch used by
 * the recall path so it never loads the full corpus.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SqliteSessionStore.getByIds", () => {
  let tmp: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-getbyids-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    store.insertSessionForTest(
      makeSession({ id: "s1", label: "alpha", body: "BODY ONE", entities: ["NLM"], decisions: ["d1"] }),
    );
    store.insertSessionForTest(
      makeSession({ id: "s2", label: "beta", body: "BODY TWO", open: ["q1"] }),
    );
    store.insertSessionForTest(makeSession({ id: "s3", label: "gamma" }));
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns only the requested sessions", async () => {
    const got = await store.getByIds(["s1", "s3"]);
    expect(got.map((s) => s.id).sort()).toEqual(["s1", "s3"]);
  });

  it("returns an empty array for an empty id list", async () => {
    expect(await store.getByIds([])).toEqual([]);
  });

  it("ignores ids that do not exist", async () => {
    const got = await store.getByIds(["s2", "missing"]);
    expect(got.map((s) => s.id)).toEqual(["s2"]);
  });

  it("populates entities and markers but omits body (body is empty)", async () => {
    const got = await store.getByIds(["s1"]);
    const s1 = got[0];
    expect(s1?.entities).toEqual(["NLM"]);
    expect(s1?.decisions).toEqual(["d1"]);
    expect(s1?.body).toBe("");
  });
});
