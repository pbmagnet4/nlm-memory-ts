/**
 * insertSession defense-in-depth: a supersedes target equal to the record's
 * own id must not write a self-loop edge or flip the row to 'superseded'.
 * Backstops the scan-path guard (scanOnce computes supersedes=null on same-id
 * resume) against any caller that passes a self-referential supersedes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  IngestRecord,
  SqliteSessionStore,
} from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    id: "sess_self",
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

describe("insertSession self-supersede guard", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-selfsup-"));
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

  it("supersedes === record.id leaves no edge and status stays 'closed'", async () => {
    await store.insertSession(makeRecord({ id: "sess_self" }), null, {
      priorSessionId: "sess_self",
      kind: "replaces",
    });

    const db = store.rawDb();
    const edges = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM session_edges")
      .get();
    expect(edges?.c).toBe(0);

    const status = db
      .prepare<[string], { status: string }>("SELECT status FROM sessions WHERE id = ?")
      .get("sess_self");
    expect(status?.status).toBe("closed");
  });
});
