/**
 * Fix A — post-hoc markSuperseded cascades to extracted facts.
 *
 * markSuperseded(predecessorId, successorId) must link each predecessor fact
 * to its matching successor fact by (subject, predicate). Facts with no
 * counterpart in the successor session must be left untouched.
 *
 * Contrast with fact-supersedence.test.ts which covers the atomic ingest path.
 * This file covers the post-hoc path (explicit markSuperseded call).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import type {
  IngestRecord,
  SqliteSessionStore,
} from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { Fact } from "../../src/shared/types.js";
import { makeFact } from "../fixtures/facts.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    id: "sess_test",
    runtime: "claude-code",
    runtimeSessionId: "test-1",
    startedAt: "2026-05-19T10:00:00Z",
    endedAt: "2026-05-19T10:30:00Z",
    durationMin: 30,
    label: "L",
    summary: "S",
    body: "",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    ...overrides,
  };
}

function fact(overrides: Partial<Fact>): Fact {
  return makeFact({
    id: `fact_${Math.random().toString(36).slice(2, 10)}`,
    confidence: 0.9,
    ...overrides,
  });
}

describe("Fix A — post-hoc supersedence cascades to facts", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  let factStore: SqliteFactStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-cascade-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
    factStore = storage.facts;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("predecessor fact is linked to matching successor fact after markSuperseded", async () => {
    const factA = fact({
      id: "f_A",
      subject: "nlm-memory-ts",
      predicate: "framework",
      value: "Fastify",
      sourceSessionId: "sess_A",
      createdAt: "2026-05-18T10:00:00Z",
    });
    await store.insertSession(
      makeRecord({ id: "sess_A", startedAt: "2026-05-18T10:00:00Z" }),
      null, null,
      { factStore, facts: [factA] },
    );

    const factB = fact({
      id: "f_B",
      subject: "nlm-memory-ts",
      predicate: "framework",
      value: "Hono",
      sourceSessionId: "sess_B",
      createdAt: "2026-05-19T10:00:00Z",
    });
    // Insert sess_B WITHOUT the factSink-based supersedence path — seed facts
    // directly so we can verify the post-hoc path independently.
    await store.insertSession(
      makeRecord({ id: "sess_B", startedAt: "2026-05-19T10:00:00Z" }),
    );
    await factStore.insert(factB);

    // Before markSuperseded, fact A is still current.
    expect((await factStore.getById("f_A"))?.supersededBy).toBeNull();

    await store.markSuperseded("sess_A", "sess_B");

    const fetchedA = await factStore.getById("f_A");
    const fetchedB = await factStore.getById("f_B");
    expect(fetchedA?.supersededBy).toBe("f_B");
    expect(fetchedB?.supersededBy).toBeNull();
  });

  it("predecessor fact with no counterpart in successor is left un-superseded", async () => {
    const factA = fact({
      id: "f_A",
      subject: "nlm-memory-ts",
      predicate: "framework",
      value: "Fastify",
      sourceSessionId: "sess_A",
      createdAt: "2026-05-18T10:00:00Z",
    });
    await store.insertSession(
      makeRecord({ id: "sess_A", startedAt: "2026-05-18T10:00:00Z" }),
      null, null,
      { factStore, facts: [factA] },
    );

    // sess_B has no fact for (nlm-memory-ts, framework)
    await store.insertSession(
      makeRecord({ id: "sess_B", startedAt: "2026-05-19T10:00:00Z" }),
    );

    await store.markSuperseded("sess_A", "sess_B");

    const fetchedA = await factStore.getById("f_A");
    expect(fetchedA?.supersededBy).toBeNull();
  });

  it("recall_facts (list without includeSuperseded) no longer returns predecessor fact", async () => {
    const factA = fact({
      id: "f_A",
      subject: "nlm-memory-ts",
      predicate: "framework",
      value: "Fastify",
      sourceSessionId: "sess_A",
      createdAt: "2026-05-18T10:00:00Z",
    });
    await store.insertSession(
      makeRecord({ id: "sess_A", startedAt: "2026-05-18T10:00:00Z" }),
      null, null,
      { factStore, facts: [factA] },
    );

    const factB = fact({
      id: "f_B",
      subject: "nlm-memory-ts",
      predicate: "framework",
      value: "Hono",
      sourceSessionId: "sess_B",
      createdAt: "2026-05-19T10:00:00Z",
    });
    await store.insertSession(
      makeRecord({ id: "sess_B", startedAt: "2026-05-19T10:00:00Z" }),
    );
    await factStore.insert(factB);

    await store.markSuperseded("sess_A", "sess_B");

    // Default list (no includeSuperseded) should only return the current fact.
    const current = await factStore.list({ subject: "nlm-memory-ts", predicate: "framework" });
    expect(current.map((f) => f.id)).toEqual(["f_B"]);

    // With includeSuperseded both appear.
    const all = await factStore.list({
      subject: "nlm-memory-ts",
      predicate: "framework",
      includeSuperseded: true,
    });
    expect(all.map((f) => f.id).sort()).toEqual(["f_A", "f_B"]);
  });

  it("partial overlap: only facts with a matching (subject, predicate) in successor get linked", async () => {
    // Session A has two facts; successor only covers one of them.
    await store.insertSession(
      makeRecord({ id: "sess_A", startedAt: "2026-05-18T10:00:00Z" }),
      null, null,
      {
        factStore,
        facts: [
          fact({ id: "f_A1", subject: "proj", predicate: "framework", value: "Fastify", sourceSessionId: "sess_A", createdAt: "2026-05-18T10:00:00Z" }),
          fact({ id: "f_A2", subject: "proj", predicate: "endpoint", value: ":8080", sourceSessionId: "sess_A", createdAt: "2026-05-18T10:00:00Z" }),
        ],
      },
    );

    // sess_B only replaces the framework fact, not the endpoint fact.
    await store.insertSession(
      makeRecord({ id: "sess_B", startedAt: "2026-05-19T10:00:00Z" }),
    );
    const factB = fact({ id: "f_B1", subject: "proj", predicate: "framework", value: "Hono", sourceSessionId: "sess_B", createdAt: "2026-05-19T10:00:00Z" });
    await factStore.insert(factB);

    await store.markSuperseded("sess_A", "sess_B");

    // framework fact was replaced → linked
    expect((await factStore.getById("f_A1"))?.supersededBy).toBe("f_B1");
    // endpoint fact has no successor → stays current
    expect((await factStore.getById("f_A2"))?.supersededBy).toBeNull();
  });
});
