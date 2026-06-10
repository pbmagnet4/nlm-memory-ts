/**
 * Supersedence split (Task #298): mechanical re-ingest writes a 'replaces'
 * edge + 'replaced' predecessor status; operator overturn (markSuperseded)
 * keeps 'supersedes' / 'superseded'. Recall excludes both statuses. See
 * docs/plans/2026-06-10-supersedence-split.md.
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
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function makeRecord(id: string, overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    id,
    runtime: "hermes",
    runtimeSessionId: id,
    startedAt: "2026-06-10T10:00:00Z",
    endedAt: "2026-06-10T10:30:00Z",
    durationMin: 30,
    label: "L",
    summary: "S",
    body: "",
    status: "closed",
    transcriptKind: "hermes-jsonl",
    transcriptPath: "/transcripts/grown.jsonl",
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    ...overrides,
  };
}

describe("supersedence split", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-split-"));
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

  const statusOf = (id: string) =>
    store.rawDb()
      .prepare<[string], { status: string }>("SELECT status FROM sessions WHERE id = ?")
      .get(id)?.status;

  const edgeKind = (from: string, to: string) =>
    store.rawDb()
      .prepare<[string, string], { kind: string }>(
        "SELECT kind FROM session_edges WHERE from_session = ? AND to_session = ?",
      )
      .get(from, to)?.kind;

  it("resume re-ingest under a new id → predecessor 'replaced', edge 'replaces'", async () => {
    await store.insertSession(makeRecord("sess_v1"));
    await store.insertSession(makeRecord("sess_v2"), null, {
      priorSessionId: "sess_v1",
      kind: "replaces",
    });

    expect(statusOf("sess_v1")).toBe("replaced");
    expect(statusOf("sess_v2")).toBe("closed");
    expect(edgeKind("sess_v2", "sess_v1")).toBe("replaces");
  });

  it("markSuperseded leaves 'supersedes' / 'superseded' unchanged", async () => {
    await store.insertSession(makeRecord("sess_old"));
    await store.insertSession(makeRecord("sess_new"));
    await store.markSuperseded("sess_old", "sess_new");

    expect(statusOf("sess_old")).toBe("superseded");
    expect(statusOf("sess_new")).toBe("closed");
    expect(edgeKind("sess_new", "sess_old")).toBe("supersedes");
  });

  it("keyword recall excludes both superseded and replaced sessions", async () => {
    store.insertSessionForTest(
      makeSession({ id: "s_active", label: "pgvector active", body: "pgvector kept", status: "closed" }),
    );
    store.insertSessionForTest(
      makeSession({ id: "s_superseded", label: "pgvector superseded", body: "pgvector overturned", status: "superseded" }),
    );
    store.insertSessionForTest(
      makeSession({ id: "s_replaced", label: "pgvector replaced", body: "pgvector reparsed", status: "replaced" }),
    );

    const hits = await store.keywordSearch("pgvector", 10);
    const ids = hits.map((h) => h.sessionId);
    expect(ids).toContain("s_active");
    expect(ids).not.toContain("s_superseded");
    expect(ids).not.toContain("s_replaced");
  });
});
