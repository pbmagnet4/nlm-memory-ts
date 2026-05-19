/**
 * SqliteFactStore against real SQLite + real migrations. Uses a tmp DB per
 * test so we exercise the actual schema, not a fake.
 *
 * Phase B.1: storage substrate only. No extraction, no recall service.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SqliteFactStore (integration)", () => {
  let tmp: string;
  let sessionStore: SqliteSessionStore;
  let factStore: SqliteFactStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nle-facts-"));
    sessionStore = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    factStore = new SqliteFactStore(sessionStore.rawDb());
    // Facts FK to sessions(id); seed one parent session so inserts don't trip
    // the foreign key constraint.
    sessionStore.insertSessionForTest(
      makeSession({ id: "sess_parent", label: "Parent session" }),
    );
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("inserts and retrieves a fact round-trip", async () => {
    const fact = makeFact({ id: "fact_1", sourceSessionId: "sess_parent" });
    await factStore.insert(fact);
    const fetched = await factStore.getById("fact_1");
    expect(fetched).toEqual(fact);
  });

  it("returns null for missing ids", async () => {
    expect(await factStore.getById("nonexistent")).toBeNull();
  });

  it("insertMany commits atomically", async () => {
    await factStore.insertMany([
      makeFact({ id: "fact_a", subject: "alpha", sourceSessionId: "sess_parent" }),
      makeFact({ id: "fact_b", subject: "beta", sourceSessionId: "sess_parent" }),
    ]);
    expect(await factStore.getById("fact_a")).not.toBeNull();
    expect(await factStore.getById("fact_b")).not.toBeNull();
  });

  it("insertMany rolls back the whole batch on duplicate id", async () => {
    await factStore.insert(
      makeFact({ id: "fact_existing", sourceSessionId: "sess_parent" }),
    );
    await expect(
      factStore.insertMany([
        makeFact({ id: "fact_new", subject: "alpha", sourceSessionId: "sess_parent" }),
        makeFact({ id: "fact_existing", subject: "beta", sourceSessionId: "sess_parent" }),
      ]),
    ).rejects.toThrow();
    expect(await factStore.getById("fact_new")).toBeNull();
  });

  it("findCurrent returns only non-superseded facts", async () => {
    await factStore.insert(
      makeFact({
        id: "fact_old",
        subject: "nle-memory-ts",
        predicate: "framework",
        value: "Fastify",
        sourceSessionId: "sess_parent",
        createdAt: "2026-05-18T10:00:00Z",
      }),
    );
    await factStore.insert(
      makeFact({
        id: "fact_new",
        subject: "nle-memory-ts",
        predicate: "framework",
        value: "Hono",
        sourceSessionId: "sess_parent",
        createdAt: "2026-05-19T10:00:00Z",
      }),
    );
    await factStore.markSuperseded("fact_old", "fact_new");

    const current = await factStore.findCurrent("nle-memory-ts", "framework");
    expect(current?.id).toBe("fact_new");
    expect(current?.value).toBe("Hono");
  });

  it("findCurrent returns null when no current fact exists", async () => {
    expect(await factStore.findCurrent("nle-memory-ts", "framework")).toBeNull();
  });

  it("list filters by subject and excludes superseded by default", async () => {
    await factStore.insertMany([
      makeFact({
        id: "f1",
        subject: "mac-pro",
        predicate: "endpoint",
        value: "http://macpro:8080/v1",
        sourceSessionId: "sess_parent",
        createdAt: "2026-05-19T10:00:00Z",
      }),
      makeFact({
        id: "f2",
        subject: "mac-pro",
        predicate: "model",
        value: "qwen2.5-3b",
        sourceSessionId: "sess_parent",
        createdAt: "2026-05-19T10:05:00Z",
      }),
      makeFact({
        id: "f3",
        subject: "other",
        predicate: "framework",
        value: "Hono",
        sourceSessionId: "sess_parent",
      }),
    ]);
    await factStore.markSuperseded("f1", "f2");

    const current = await factStore.list({ subject: "mac-pro" });
    expect(current.map((f) => f.id)).toEqual(["f2"]);

    const all = await factStore.list({
      subject: "mac-pro",
      includeSuperseded: true,
    });
    expect(all.map((f) => f.id)).toEqual(["f2", "f1"]); // created_at DESC
  });

  it("list with predicate narrows further", async () => {
    await factStore.insertMany([
      makeFact({ id: "f1", subject: "x", predicate: "alpha", sourceSessionId: "sess_parent" }),
      makeFact({ id: "f2", subject: "x", predicate: "beta", sourceSessionId: "sess_parent" }),
    ]);
    const out = await factStore.list({ subject: "x", predicate: "beta" });
    expect(out.map((f) => f.id)).toEqual(["f2"]);
  });

  it("listBySession returns all facts (including superseded) for a session", async () => {
    sessionStore.insertSessionForTest(makeSession({ id: "sess_other" }));
    await factStore.insertMany([
      makeFact({ id: "f1", subject: "a", sourceSessionId: "sess_parent" }),
      makeFact({ id: "f2", subject: "b", sourceSessionId: "sess_parent" }),
      makeFact({ id: "f3", subject: "c", sourceSessionId: "sess_other" }),
    ]);
    await factStore.markSuperseded("f1", "f2");

    const out = await factStore.listBySession("sess_parent");
    expect(out.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
  });

  it("markSuperseded throws when either id is missing", async () => {
    await factStore.insert(makeFact({ id: "real", sourceSessionId: "sess_parent" }));
    await expect(factStore.markSuperseded("nope", "real")).rejects.toThrow(/not found/);
    await expect(factStore.markSuperseded("real", "nope")).rejects.toThrow(/not found/);
  });

  it("markSuperseded rejects self-supersedence", async () => {
    await factStore.insert(makeFact({ id: "self", sourceSessionId: "sess_parent" }));
    await expect(factStore.markSuperseded("self", "self")).rejects.toThrow(/itself/);
  });

  it("markSuperseded with null reverses an earlier supersedence", async () => {
    await factStore.insertMany([
      makeFact({ id: "a", subject: "s", predicate: "p", value: "v1", sourceSessionId: "sess_parent" }),
      makeFact({ id: "b", subject: "s", predicate: "p", value: "v2", sourceSessionId: "sess_parent" }),
    ]);
    await factStore.markSuperseded("a", "b");
    expect((await factStore.getById("a"))?.supersededBy).toBe("b");
    await factStore.markSuperseded("a", null);
    expect((await factStore.getById("a"))?.supersededBy).toBeNull();
  });

  it("CHECK constraints reject invalid kind", async () => {
    await expect(
      factStore.insert(
        // @ts-expect-error — exercising the CHECK constraint at runtime
        makeFact({ id: "bad", kind: "garbage", sourceSessionId: "sess_parent" }),
      ),
    ).rejects.toThrow();
  });

  it("CHECK constraints reject confidence out of [0, 1]", async () => {
    await expect(
      factStore.insert(
        makeFact({ id: "bad", confidence: 1.5, sourceSessionId: "sess_parent" }),
      ),
    ).rejects.toThrow();
  });

  it("FK constraint rejects facts pointing at missing sessions", async () => {
    await expect(
      factStore.insert(
        makeFact({ id: "orphan", sourceSessionId: "no_such_session" }),
      ),
    ).rejects.toThrow();
  });
});
