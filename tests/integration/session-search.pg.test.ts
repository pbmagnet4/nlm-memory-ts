/**
 * PgSessionStore semantic and keyword search tests — verify that
 * superseded sessions are filtered out from recall results.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL to a
 * connection string, e.g.:
 *   export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"
 *
 * Skips when the env var is absent.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { makeSession } from "../fixtures/sessions.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);
// PG has no version-gated runner; init() applies 001 only. Apply the
// operator-shipped 019 split migration so the schema admits 'replaced' /
// 'replaces' (mirrors production, where an operator runs it once).
const PG_019_SQL = readFileSync(join(MIGRATIONS_DIR, "019_split_replaces.sql"), "utf8");

function makeRecord(id: string, transcriptPath: string): IngestRecord {
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
    transcriptPath,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
  };
}

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

describe.skipIf(!PG_TEST_URL)("PgSessionStore search with supersedence", () => {
  let storage: PgStorage;

  beforeEach(async () => {
    if (!PG_TEST_URL) throw new Error("NLM_PG_TEST_URL not set");
    storage = PgStorage.create({
      connectionString: PG_TEST_URL,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    await storage.pgPool().query(PG_019_SQL);
    await storage.pgPool().query(TRUNCATE_SQL);
  });

  afterEach(async () => {
    await storage.close();
  });

  describe("keywordSearch", () => {
    it("filters out superseded sessions", async () => {
      const store = storage.sessions;

      // Insert two sessions
      const oldSession = makeSession({
        id: "s_old_kw",
        label: "elasticsearch migration",
        body: "old search platform elasticsearch",
      });
      const newSession = makeSession({
        id: "s_new_kw",
        label: "opensearch upgrade",
        body: "new search platform opensearch",
      });

      await store.insertSessionForTest(oldSession);
      await store.insertSessionForTest(newSession);

      // Mark old as superseded
      await store.markSuperseded("s_old_kw", "s_new_kw");

      // Search for term unique to old session
      const results = await store.keywordSearch("elasticsearch", 10);
      const sessionIds = results.map((r) => r.sessionId);

      expect(sessionIds).not.toContain("s_old_kw");
      expect(sessionIds).not.toContain("s_new_kw"); // search term not in new session

      // Search for term in new session
      const newResults = await store.keywordSearch("opensearch", 10);
      const newIds = newResults.map((r) => r.sessionId);

      expect(newIds).toContain("s_new_kw");
      expect(newIds).not.toContain("s_old_kw");
    });
  });

  describe("semanticSearch", () => {
    it("filters out superseded sessions", async () => {
      const store = storage.sessions;

      // Insert two sessions
      const oldSession = makeSession({
        id: "s_old_sem",
        label: "pgvector proof of concept",
        body: "testing pgvector extension",
      });
      const newSession = makeSession({
        id: "s_new_sem",
        label: "pgvector production deployment",
        body: "deployed pgvector in production environment",
      });

      await store.insertSessionForTest(oldSession);
      await store.insertSessionForTest(newSession);

      // Embed both with similar vectors (simulating semantic similarity)
      // For PG, we need to directly insert into session_embedding_chunks
      const vecStr1 = `[${Array(768)
        .fill(0)
        .map((_, i) => (i === 0 ? 1 : 0))
        .join(",")}]`;
      const vecStr2 = `[${Array(768)
        .fill(0)
        .map((_, i) => (i === 0 ? 1 : i === 1 ? 0.5 : 0))
        .join(",")}]`;

      const pool = storage.pgPool();
      await pool.query(
        "INSERT INTO session_embedding_chunks (session_id, chunk_idx, embedding) VALUES ($1, 0, $2::vector)",
        ["s_old_sem", vecStr1],
      );
      await pool.query(
        "INSERT INTO session_embedding_chunks (session_id, chunk_idx, embedding) VALUES ($1, 0, $2::vector)",
        ["s_new_sem", vecStr2],
      );

      // Mark old as superseded
      await store.markSuperseded("s_old_sem", "s_new_sem");

      // Query with a similar vector
      const queryVec = new Float32Array(768);
      queryVec[0] = 1;
      const results = await store.semanticSearch(queryVec, 10);
      const sessionIds = results.map((r) => r.sessionId);

      expect(sessionIds).toContain("s_new_sem");
      expect(sessionIds).not.toContain("s_old_sem");
    });
  });

  describe("supersedence split", () => {
    const statusOf = (id: string) =>
      storage.pgPool()
        .query<{ status: string }>("SELECT status FROM sessions WHERE id = $1", [id])
        .then((r) => r.rows[0]?.status);
    const edgeKind = (from: string, to: string) =>
      storage.pgPool()
        .query<{ kind: string }>(
          "SELECT kind FROM session_edges WHERE from_session = $1 AND to_session = $2",
          [from, to],
        )
        .then((r) => r.rows[0]?.kind);

    it("mechanical re-ingest writes a 'replaces' edge + 'replaced' predecessor status", async () => {
      const store = storage.sessions;
      await store.insertSession(makeRecord("p_v1", "/t/grown.jsonl"));
      await store.insertSession(makeRecord("p_v2", "/t/grown.jsonl"), null, {
        priorSessionId: "p_v1",
        kind: "replaces",
      });

      expect(await statusOf("p_v1")).toBe("replaced");
      expect(await statusOf("p_v2")).toBe("closed");
      expect(await edgeKind("p_v2", "p_v1")).toBe("replaces");
    });

    it("markSuperseded keeps 'supersedes' / 'superseded' unchanged", async () => {
      const store = storage.sessions;
      await store.insertSession(makeRecord("p_old", "/t/a.jsonl"));
      await store.insertSession(makeRecord("p_new", "/t/b.jsonl"));
      await store.markSuperseded("p_old", "p_new");

      expect(await statusOf("p_old")).toBe("superseded");
      expect(await edgeKind("p_new", "p_old")).toBe("supersedes");
    });

    it("keyword recall excludes both superseded and replaced sessions", async () => {
      const store = storage.sessions;
      await store.insertSessionForTest(
        makeSession({ id: "p_kw_active", label: "kafka pipeline", body: "kafka active", status: "closed" }),
      );
      await store.insertSessionForTest(
        makeSession({ id: "p_kw_sup", label: "kafka old", body: "kafka overturned", status: "superseded" }),
      );
      await store.insertSessionForTest(
        makeSession({ id: "p_kw_rep", label: "kafka reparse", body: "kafka reparsed", status: "replaced" }),
      );

      const hits = await store.keywordSearch("kafka", 10);
      const ids = hits.map((h) => h.sessionId);
      expect(ids).toContain("p_kw_active");
      expect(ids).not.toContain("p_kw_sup");
      expect(ids).not.toContain("p_kw_rep");
    });
  });
});
