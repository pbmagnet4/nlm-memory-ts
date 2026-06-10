# PostgreSQL Adapter (#216) Implementation Plan

> **✅ Resume status — 2026-06-02:** All 13 tasks shipped. PgStorage, PgFactStore, PgSessionStore, PG migration, PG-native registries/actions/scheduler, and `NLM_PG_URL` bootstrap wiring all merged on `main`.
> - `f77a8d2` — PgStorage + PgFactStore + PgSessionStore adapters with contract tests (Tasks 1–8)
> - `ce046f6` — PG-native registries, actions, scheduler + NLM_PG_URL bootstrap wiring (Tasks 9–13)
>
> Plan retained as the design record. Checkboxes ticked retroactively from shipped code on 2026-06-02.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a PgStorage adapter (PgStorage + PgSessionStore + PgFactStore) that implements the Storage port, passes the existing `runFactStoreContract` contract test unchanged, and lets `nlm start` run against PostgreSQL when `NLM_PG_URL` is set.

**Architecture:** Option B (pgPool() parallel) — PgStorage implements the `Storage` port and exposes a `pgPool()` escape hatch for the 18 rawDb() callers that bypass the port today. PG-native counterparts of SourceRegistry, ProviderRegistry, ActionsLog, and Scheduler are written to take `pg.Pool` instead of `better-sqlite3.Database`. The SQLite path is untouched; both adapters coexist at runtime, selected by env var.

The key design constraint from `src/ports/storage.ts`: `withTransaction` callbacks MUST be synchronous. PgStorage honors this by collecting write ops in a queue inside the sync callback, then flushing the entire queue inside a single `BEGIN/COMMIT` after the callback returns. Read methods on tx-bound stores throw — the contract tests only call writes inside `withTransaction`.

**Tech Stack:** `pg` (node-postgres 8.x), `pgvector` npm package for vector type serialization, PostgreSQL 15+ with `pgvector` extension enabled.

---

## File Map

**Created:**
- `migrations/pg/001_initial.sql` — full PG DDL (schema + pgvector + tsvector FTS)
- `src/core/storage/pg-tx-context.ts` — PgWriteQueue + PgTxBoundFactStore + PgTxBoundSessionStore (sync callback write-queue)
- `src/core/storage/pg-fact-store.ts` — PgFactStore implements FactStore
- `src/core/storage/pg-session-store.ts` — PgSessionStore implements SessionStore
- `src/core/storage/pg-storage.ts` — PgStorage implements Storage + pgPool() accessor
- `tests/contract/storage.contract.ts` — withTransaction atomicity contract (adapter-agnostic)
- `tests/integration/fact-store.pg.test.ts` — PG harness for runFactStoreContract
- `tests/integration/storage.pg.test.ts` — PG harness for runStorageContract

**Modified:**
- `package.json` — add `pg`, `@types/pg`, `pgvector` dependencies
- `src/core/sources/source-registry.ts` — add PgSourceRegistry class
- `src/core/providers/provider-registry.ts` — add PgProviderRegistry class
- `src/core/actions/actions-log.ts` — add PG-accepting counterparts of writeAction/undoAction/listActions
- `src/core/scheduler/scan-once.ts` — PG overload for scanOnce + recordFailed
- `src/core/scheduler/scheduler.ts` — wire PG overloads when pgPool() present
- `src/cli/nlm.ts` — env-based storage selection (NLM_PG_URL)
- `src/http/app.ts` — env-based storage selection, extend HttpDeps.liveStore type

---

## Task 1: Add PG Dependencies

**Files:**
- Modify: `package.json`

- [x] **Step 1: Install dependencies**

```bash
cd "~/nlm-memory"
npm install pg pgvector
npm install --save-dev @types/pg
```

- [x] **Step 2: Verify installation**

```bash
node -e "const { Pool } = require('pg'); console.log('pg ok')"
node -e "const { toSql } = require('pgvector'); console.log('pgvector ok')"
```

Expected: two "ok" lines with no errors.

- [x] **Step 3: Run tests to verify nothing broke**

```bash
npm test
```

Expected: same pass count as before (719 tests passing).

---

## Task 2: PG Migration

**Files:**
- Create: `migrations/pg/001_initial.sql`

- [x] **Step 1: Write PG schema**

Create `migrations/pg/001_initial.sql`:

```sql
-- NLM PostgreSQL schema v1.
-- Mirrors SQLite migrations/000–016 but uses PG idioms:
--   - SERIAL / TEXT for PKs (no AUTOINCREMENT)
--   - pgvector for embeddings instead of sqlite-vec
--   - tsvector generated column + GIN for FTS5 equivalent
--   - NOW() instead of datetime('now')
--   - ON CONFLICT DO NOTHING / DO UPDATE instead of INSERT OR IGNORE / REPLACE

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Sessions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  runtime              TEXT NOT NULL,
  runtime_session_id   TEXT,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  duration_min         REAL,
  label                TEXT NOT NULL,
  summary              TEXT NOT NULL,
  body                 TEXT,
  status               TEXT NOT NULL CHECK (status IN ('active', 'closed', 'superseded')),
  transcript_kind      TEXT,
  transcript_path      TEXT,
  transcript_offset    BIGINT,
  transcript_length    BIGINT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fts_vector           TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(label, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED
);

CREATE INDEX IF NOT EXISTS sessions_fts_idx ON sessions USING GIN(fts_vector);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

-- ── Session embeddings (chunks + map, mirrors SQLite architecture) ──────────
CREATE TABLE IF NOT EXISTS session_embedding_chunks (
  chunk_id   SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_idx  INTEGER NOT NULL,
  embedding  vector(768) NOT NULL
);

CREATE INDEX IF NOT EXISTS session_chunks_embedding_idx
  ON session_embedding_chunks USING ivfflat (embedding vector_l2_ops)
  WITH (lists = 100);

CREATE TABLE IF NOT EXISTS session_chunk_map (
  chunk_id   INTEGER NOT NULL REFERENCES session_embedding_chunks(chunk_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_idx  INTEGER NOT NULL,
  PRIMARY KEY (chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_session_chunk_map_session ON session_chunk_map(session_id);

-- ── Markers (decisions + open questions) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS markers (
  id         SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('decision', 'open')),
  text       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_markers_session ON markers(session_id);

-- ── Entities ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
  canonical          TEXT PRIMARY KEY,
  type               TEXT NOT NULL DEFAULT 'candidate',
  status             TEXT NOT NULL DEFAULT 'candidate',
  source             TEXT NOT NULL DEFAULT 'auto-detected',
  first_seen_session TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  last_seen_session  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  session_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_entities (
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  entity_canonical  TEXT NOT NULL REFERENCES entities(canonical) ON DELETE CASCADE,
  PRIMARY KEY (session_id, entity_canonical)
);

-- ── Session edges ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_edges (
  from_session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  to_session   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('supersedes', 'continues')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_session, to_session, kind)
);

-- ── Facts ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS facts (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('decision', 'open', 'attribute')),
  subject            TEXT NOT NULL,
  predicate          TEXT NOT NULL,
  value              TEXT NOT NULL,
  source_session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_quote       TEXT,
  created_at         TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  superseded_by      TEXT REFERENCES facts(id) ON DELETE SET NULL,
  confidence         REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

CREATE INDEX IF NOT EXISTS idx_facts_subject_predicate_current
  ON facts(subject, predicate) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_subject_current
  ON facts(subject) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_session
  ON facts(source_session_id);

-- ── Fact embeddings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fact_embeddings (
  fact_id    TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  embedding  vector(768) NOT NULL
);

CREATE INDEX IF NOT EXISTS fact_embeddings_idx
  ON fact_embeddings USING ivfflat (embedding vector_l2_ops)
  WITH (lists = 100);

-- ── Actions (event-sourced action log) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS actions (
  id           TEXT PRIMARY KEY,
  timestamp    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  payload      TEXT,
  actor        TEXT NOT NULL DEFAULT 'user',
  runtime      TEXT,
  reverted_by  TEXT REFERENCES actions(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_actions_subject ON actions(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_actions_kind ON actions(kind);
CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON actions(timestamp DESC);

-- ── Sources registry ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex', 'hermes', 'hermes-agent', 'aider', 'cursor', 'windsurf', 'opencode', 'pi', 'jsonl-generic', 'webhook')),
  name           TEXT NOT NULL UNIQUE,
  path_or_url    TEXT,
  runtime_label  TEXT NOT NULL,
  parse_config   TEXT NOT NULL DEFAULT '{}',
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  token          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Providers registry ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS providers (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('deepseek', 'ollama', 'openai', 'anthropic', 'openrouter', 'openai-compatible')),
  name           TEXT NOT NULL UNIQUE,
  base_url       TEXT,
  api_key        TEXT,
  default_model  TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Adapter state (per-runtime offsets for resumability) ─────────────────────
CREATE TABLE IF NOT EXISTS adapter_state (
  adapter_name       TEXT NOT NULL,
  source_path        TEXT NOT NULL,
  last_offset        BIGINT NOT NULL DEFAULT 0,
  last_processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  file_size          BIGINT,
  session_id         TEXT,
  failure_count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (adapter_name, source_path)
);

-- ── Schema migrations tracker ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name) VALUES (1, '001_initial')
  ON CONFLICT DO NOTHING;
```

- [x] **Step 2: Verify the file exists**

```bash
ls -la "~/nlm-memory/migrations/pg/001_initial.sql"
```

Expected: file visible, non-zero size.

---

## Task 3: PgTxContext (write-queue for sync callbacks)

**Files:**
- Create: `src/core/storage/pg-tx-context.ts`

This module implements the sync-callback write-queue pattern. When `PgStorage.withTransaction(fn)` runs, it passes tx-bound store instances whose write methods queue SQL ops synchronously. After `fn` returns, PgStorage executes the queue inside a single `BEGIN/COMMIT`.

Read methods throw because they cannot observe uncommitted queue state. The contract tests never call reads inside `withTransaction`.

- [x] **Step 1: Write the module**

Create `src/core/storage/pg-tx-context.ts`:

```typescript
/**
 * PgTxContext — write-queue for PgStorage.withTransaction.
 *
 * PgStorage.withTransaction requires a sync callback (port contract). PG
 * transactions are async. Bridge: sync callback queues SQL ops; PgStorage
 * flushes the queue in one BEGIN/COMMIT after the callback returns.
 *
 * Read methods throw — they cannot see uncommitted queue state. The
 * FactStore/SessionStore contracts never read inside withTransaction.
 */

import type {
  FactListFilter,
  FactQuery,
  FactSemanticNeighbor,
  FactStore,
} from "@ports/fact-store.js";
import type {
  KeywordNeighbor,
  SemanticNeighbor,
  SessionFilter,
  SessionStore,
} from "@ports/session-store.js";
import type { Fact, FactHistoryChain, Session, SessionStatus } from "@shared/types.js";

export interface QueuedOp {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function noRead(method: string): never {
  throw new Error(`PgStorage.withTransaction: ${method} read not supported inside sync callback`);
}

export class PgTxBoundFactStore implements FactStore {
  constructor(private readonly q: QueuedOp[]) {}

  insert(fact: Fact): Promise<void> {
    this.q.push(insertFactOp(fact));
    return Promise.resolve();
  }

  insertMany(facts: ReadonlyArray<Fact>): Promise<void> {
    for (const f of facts) this.q.push(insertFactOp(f));
    return Promise.resolve();
  }

  markSuperseded(oldId: string, newId: string | null): Promise<void> {
    this.q.push({
      sql: "UPDATE facts SET superseded_by = $1 WHERE id = $2",
      params: [newId, oldId],
    });
    return Promise.resolve();
  }

  ingestSessionFacts(sessionId: string, facts: ReadonlyArray<Fact>): Promise<void> {
    this.q.push({
      sql: "DELETE FROM facts WHERE source_session_id = $1",
      params: [sessionId],
    });
    for (const f of facts) this.q.push(insertFactOp(f));
    if (facts.length > 0) {
      // Supersedence: for each new fact, mark any existing current fact with
      // the same (subject, predicate) as superseded. Batch as a single
      // UPDATE ... FROM (VALUES ...) so the queue stays O(1) SQL statements
      // per ingest call regardless of batch size.
      const values = facts
        .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
        .join(", ");
      const params: unknown[] = [];
      for (const f of facts) params.push(f.subject, f.predicate, f.id);
      this.q.push({
        sql: `
          UPDATE facts AS old
          SET superseded_by = new_f.new_id
          FROM (VALUES ${values}) AS new_f(subject, predicate, new_id)
          WHERE old.subject = new_f.subject
            AND old.predicate = new_f.predicate
            AND old.superseded_by IS NULL
            AND old.id != new_f.new_id
        `,
        params,
      });
    }
    return Promise.resolve();
  }

  upsertEmbedding(factId: string, vector: Float32Array): Promise<void> {
    this.q.push({
      sql: `
        INSERT INTO fact_embeddings (fact_id, embedding)
        VALUES ($1, $2)
        ON CONFLICT (fact_id) DO UPDATE SET embedding = EXCLUDED.embedding
      `,
      params: [factId, `[${Array.from(vector).join(",")}]`],
    });
    return Promise.resolve();
  }

  getById(_id: string): Promise<Fact | null> { return noRead("FactStore.getById"); }
  findCurrent(_s: string, _p: string): Promise<Fact | null> { return noRead("FactStore.findCurrent"); }
  list(_q: FactQuery): Promise<ReadonlyArray<Fact>> { return noRead("FactStore.list"); }
  listBySession(_id: string): Promise<ReadonlyArray<Fact>> { return noRead("FactStore.listBySession"); }
  listForRecall(_f: FactListFilter): Promise<ReadonlyArray<Fact>> { return noRead("FactStore.listForRecall"); }
  semanticSearch(_v: Float32Array, _n: number): Promise<ReadonlyArray<FactSemanticNeighbor>> { return noRead("FactStore.semanticSearch"); }
  getHistory(_s: string, _p?: string): Promise<ReadonlyArray<FactHistoryChain>> { return noRead("FactStore.getHistory"); }
}

export class PgTxBoundSessionStore implements SessionStore {
  constructor(private readonly q: QueuedOp[]) {}

  updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    if (status === "idle") {
      throw new Error("Cannot persist derived status 'idle'");
    }
    this.q.push({
      sql: "UPDATE sessions SET status = $1, updated_at = NOW() WHERE id = $2",
      params: [status, sessionId],
    });
    return Promise.resolve();
  }

  markSuperseded(predecessorId: string, successorId: string): Promise<void> {
    this.q.push({
      sql: `
        INSERT INTO session_edges (from_session, to_session, kind)
        VALUES ($1, $2, 'supersedes')
        ON CONFLICT DO NOTHING
      `,
      params: [successorId, predecessorId],
    });
    this.q.push({
      sql: "UPDATE sessions SET status = 'superseded', updated_at = NOW() WHERE id = $1",
      params: [predecessorId],
    });
    return Promise.resolve();
  }

  list(_filter?: SessionFilter): Promise<ReadonlyArray<Session>> { return noRead("SessionStore.list"); }
  getById(_id: string): Promise<Session | null> { return noRead("SessionStore.getById"); }
  getByIds(_ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>> { return noRead("SessionStore.getByIds"); }
  semanticSearch(_v: Float32Array, _n: number): Promise<ReadonlyArray<SemanticNeighbor>> { return noRead("SessionStore.semanticSearch"); }
  keywordSearch(_q: string, _n: number): Promise<ReadonlyArray<KeywordNeighbor>> { return noRead("SessionStore.keywordSearch"); }
}

function insertFactOp(f: Fact): QueuedOp {
  return {
    sql: `
      INSERT INTO facts (
        id, kind, subject, predicate, value, source_session_id,
        source_quote, created_at, superseded_by, confidence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    params: [
      f.id, f.kind, f.subject, f.predicate, f.value,
      f.sourceSessionId, f.sourceQuote, f.createdAt, f.supersededBy, f.confidence,
    ],
  };
}
```

- [x] **Step 2: Typecheck**

```bash
cd "~/nlm-memory" && npx tsc -p tsconfig.json --noEmit 2>&1 | head -20
```

Expected: no errors in `pg-tx-context.ts`.

---

## Task 4: PgFactStore

**Files:**
- Create: `src/core/storage/pg-fact-store.ts`

- [x] **Step 1: Write PgFactStore**

Create `src/core/storage/pg-fact-store.ts`:

```typescript
/**
 * PgFactStore — FactStore implementation over pg.Pool + pgvector.
 *
 * Receives its Pool from PgStorage. Never opens its own connection.
 * See docs/plans/factstore-design.md and src/ports/fact-store.ts for
 * the contract each method must honor.
 */

import type { Pool, PoolClient } from "pg";
import type {
  FactListFilter,
  FactQuery,
  FactSemanticNeighbor,
  FactStore,
} from "@ports/fact-store.js";
import type { Fact, FactHistoryChain, FactKind } from "@shared/types.js";

type FactRow = {
  id: string;
  kind: FactKind;
  subject: string;
  predicate: string;
  value: string;
  source_session_id: string;
  source_quote: string | null;
  created_at: string;
  superseded_by: string | null;
  confidence: number;
};

export class PgFactStore implements FactStore {
  constructor(private readonly pool: Pool) {}

  async insert(fact: Fact): Promise<void> {
    await this.pool.query(
      `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
         source_quote, created_at, superseded_by, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [fact.id, fact.kind, fact.subject, fact.predicate, fact.value,
       fact.sourceSessionId, fact.sourceQuote, fact.createdAt, fact.supersededBy, fact.confidence],
    );
  }

  async insertMany(facts: ReadonlyArray<Fact>): Promise<void> {
    if (facts.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const f of facts) {
        await client.query(
          `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
             source_quote, created_at, superseded_by, confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [f.id, f.kind, f.subject, f.predicate, f.value,
           f.sourceSessionId, f.sourceQuote, f.createdAt, f.supersededBy, f.confidence],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getById(id: string): Promise<Fact | null> {
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence
       FROM facts WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? rowToFact(result.rows[0]) : null;
  }

  async findCurrent(subject: string, predicate: string): Promise<Fact | null> {
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence
       FROM facts
       WHERE subject = $1 AND predicate = $2 AND superseded_by IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [subject, predicate],
    );
    return result.rows[0] ? rowToFact(result.rows[0]) : null;
  }

  async list(query: FactQuery): Promise<ReadonlyArray<Fact>> {
    const limit = Math.max(1, Math.trunc(query.limit ?? 50));
    const includeSuperseded = query.includeSuperseded === true;
    const where: string[] = ["subject = $1"];
    const params: unknown[] = [query.subject];
    let idx = 2;
    if (query.predicate !== undefined) {
      where.push(`predicate = $${idx++}`);
      params.push(query.predicate);
    }
    if (!includeSuperseded) where.push("superseded_by IS NULL");
    params.push(limit);
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence
       FROM facts
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${idx}`,
      params,
    );
    return result.rows.map(rowToFact);
  }

  async listBySession(sessionId: string): Promise<ReadonlyArray<Fact>> {
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence
       FROM facts
       WHERE source_session_id = $1
       ORDER BY created_at ASC`,
      [sessionId],
    );
    return result.rows.map(rowToFact);
  }

  async listForRecall(filter: FactListFilter): Promise<ReadonlyArray<Fact>> {
    const where: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (filter.subject !== undefined) { where.push(`subject = $${idx++}`); params.push(filter.subject); }
    if (filter.predicate !== undefined) { where.push(`predicate = $${idx++}`); params.push(filter.predicate); }
    if (filter.kind !== undefined) { where.push(`kind = $${idx++}`); params.push(filter.kind); }
    if (filter.minConfidence !== undefined) { where.push(`confidence >= $${idx++}`); params.push(filter.minConfidence); }
    if (filter.includeSuperseded !== true) where.push("superseded_by IS NULL");
    const limit = Math.max(1, Math.trunc(filter.limit ?? 500));
    params.push(limit);
    const sql = `
      SELECT id, kind, subject, predicate, value, source_session_id,
             source_quote, created_at, superseded_by, confidence
      FROM facts
      ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `;
    const result = await this.pool.query<FactRow>(sql, params);
    return result.rows.map(rowToFact);
  }

  async markSuperseded(oldId: string, newId: string | null): Promise<void> {
    if (newId !== null && oldId === newId) {
      throw new Error("A fact cannot supersede itself");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const old = await client.query<{ id: string }>(
        "SELECT id FROM facts WHERE id = $1", [oldId],
      );
      if (old.rows.length === 0) throw new Error(`Fact ${oldId} not found`);
      if (newId !== null) {
        const next = await client.query<{ id: string }>(
          "SELECT id FROM facts WHERE id = $1", [newId],
        );
        if (next.rows.length === 0) throw new Error(`Fact ${newId} not found`);
      }
      await client.query(
        "UPDATE facts SET superseded_by = $1 WHERE id = $2", [newId, oldId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async ingestSessionFacts(
    sessionId: string,
    facts: ReadonlyArray<Fact>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM facts WHERE source_session_id = $1", [sessionId]);
      if (facts.length > 0) {
        for (const f of facts) {
          await client.query(
            `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
               source_quote, created_at, superseded_by, confidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [f.id, f.kind, f.subject, f.predicate, f.value,
             f.sourceSessionId, f.sourceQuote, f.createdAt, f.supersededBy, f.confidence],
          );
        }
        // Batch supersedence: mark existing current facts (from other sessions) as
        // superseded when a new fact has the same (subject, predicate).
        if (facts.length > 0) {
          const values = facts
            .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
            .join(", ");
          const params: unknown[] = [];
          for (const f of facts) params.push(f.subject, f.predicate, f.id);
          await client.query(
            `UPDATE facts AS old
             SET superseded_by = new_f.new_id
             FROM (VALUES ${values}) AS new_f(subject, predicate, new_id)
             WHERE old.subject = new_f.subject
               AND old.predicate = new_f.predicate
               AND old.superseded_by IS NULL
               AND old.id != new_f.new_id`,
            params,
          );
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertEmbedding(factId: string, vector: Float32Array): Promise<void> {
    const vecStr = `[${Array.from(vector).join(",")}]`;
    await this.pool.query(
      `INSERT INTO fact_embeddings (fact_id, embedding)
       VALUES ($1, $2::vector)
       ON CONFLICT (fact_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [factId, vecStr],
    );
  }

  async semanticSearch(
    queryVector: Float32Array,
    limit: number,
  ): Promise<ReadonlyArray<FactSemanticNeighbor>> {
    const k = Math.max(1, Math.trunc(limit));
    const vecStr = `[${Array.from(queryVector).join(",")}]`;
    const result = await this.pool.query<{ fact_id: string; distance: number }>(
      `SELECT fact_id, embedding <-> $1::vector AS distance
       FROM fact_embeddings
       ORDER BY embedding <-> $1::vector
       LIMIT $2`,
      [vecStr, k],
    );
    return result.rows.map((r) => ({ factId: r.fact_id, distance: r.distance }));
  }

  async getHistory(
    subject: string,
    predicate?: string,
  ): Promise<ReadonlyArray<FactHistoryChain>> {
    const result = predicate
      ? await this.pool.query<FactRow>(
          `SELECT id, kind, subject, predicate, value, source_session_id,
                  source_quote, created_at, superseded_by, confidence
           FROM facts
           WHERE subject = $1 AND predicate = $2
           ORDER BY predicate ASC, created_at DESC`,
          [subject, predicate],
        )
      : await this.pool.query<FactRow>(
          `SELECT id, kind, subject, predicate, value, source_session_id,
                  source_quote, created_at, superseded_by, confidence
           FROM facts
           WHERE subject = $1
           ORDER BY predicate ASC, created_at DESC`,
          [subject],
        );

    const byPred = new Map<string, Fact[]>();
    for (const row of result.rows) {
      const fact = rowToFact(row);
      const bucket = byPred.get(fact.predicate);
      if (bucket) bucket.push(fact);
      else byPred.set(fact.predicate, [fact]);
    }
    return [...byPred.entries()].map(([pred, history]) => ({ subject, predicate: pred, history }));
  }
}

function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    predicate: row.predicate,
    value: row.value,
    sourceSessionId: row.source_session_id,
    sourceQuote: row.source_quote,
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
    confidence: row.confidence,
  };
}
```

- [x] **Step 2: Typecheck**

```bash
cd "~/nlm-memory" && npx tsc -p tsconfig.json --noEmit 2>&1 | grep "pg-fact-store"
```

Expected: no output (no errors in that file).

---

## Task 5: PgSessionStore

**Files:**
- Create: `src/core/storage/pg-session-store.ts`

- [x] **Step 1: Write PgSessionStore**

Create `src/core/storage/pg-session-store.ts`:

```typescript
/**
 * PgSessionStore — SessionStore implementation over pg.Pool + pgvector.
 *
 * Constructor takes the Pool from PgStorage. Never opens its own connection.
 * Also exposes recentWrites() and recentMarkers() for the /live HTTP endpoints,
 * matching the extra-interface surface of SqliteSessionStore.
 */

import type { Pool } from "pg";
import type {
  KeywordNeighbor,
  SemanticNeighbor,
  SessionFilter,
  SessionStore,
} from "@ports/session-store.js";
import type { Session, SessionStatus } from "@shared/types.js";
import type { RecentMarker, RecentWrite } from "./sqlite-session-store.js";
import { tokenize } from "@core/recall/tokenize.js";
import { chunkSessionText } from "@core/embedding/chunk-body.js";
import type { IngestRecord } from "./sqlite-session-store.js";

type SessionRow = {
  id: string;
  runtime: string;
  runtime_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  duration_min: number | null;
  label: string;
  summary: string;
  status: "active" | "closed" | "superseded";
  transcript_kind: string | null;
  transcript_path: string | null;
  body: string | null;
};

export class PgSessionStore implements SessionStore {
  constructor(readonly pool: Pool) {}

  async list(filter?: SessionFilter): Promise<ReadonlyArray<Session>> {
    const result = await this.pool.query<SessionRow>(
      `SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
              label, summary, status, transcript_kind, transcript_path, body
       FROM sessions
       ORDER BY started_at ASC`,
    );
    if (result.rows.length === 0) return [];
    const ids = result.rows.map((r) => r.id);
    const [entitiesMap, markersMap] = await Promise.all([
      this.loadEntities(ids),
      this.loadMarkers(ids),
    ]);
    const sessions = result.rows.map((r) => rowToSession(r, entitiesMap, markersMap));
    if (!filter) return sessions;
    return sessions.filter((s) => {
      if (filter.entity !== undefined && !s.entities.includes(filter.entity)) return false;
      if (filter.hasDecisions === true && s.decisions.length === 0) return false;
      if (filter.hasOpenQuestions === true && s.open.length === 0) return false;
      return true;
    });
  }

  async getById(sessionId: string): Promise<Session | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
              label, summary, status, transcript_kind, transcript_path, body
       FROM sessions WHERE id = $1`,
      [sessionId],
    );
    if (!result.rows[0]) return null;
    const [entitiesMap, markersMap, edgesMap] = await Promise.all([
      this.loadEntities([sessionId]),
      this.loadMarkers([sessionId]),
      this.loadEdges([sessionId]),
    ]);
    const edges = edgesMap.get(sessionId);
    return rowToSession(result.rows[0], entitiesMap, markersMap, edges);
  }

  async getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>> {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const result = await this.pool.query<Omit<SessionRow, "body">>(
      `SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
              label, summary, status, transcript_kind, transcript_path
       FROM sessions WHERE id IN (${placeholders})`,
      [...ids],
    );
    if (result.rows.length === 0) return [];
    const foundIds = result.rows.map((r) => r.id);
    const [entitiesMap, markersMap] = await Promise.all([
      this.loadEntities(foundIds),
      this.loadMarkers(foundIds),
    ]);
    return result.rows.map((r) => rowToSession({ ...r, body: null }, entitiesMap, markersMap));
  }

  async semanticSearch(
    queryVector: Float32Array,
    limit: number,
  ): Promise<ReadonlyArray<SemanticNeighbor>> {
    const k = Math.max(1, Math.trunc(limit));
    const vecStr = `[${Array.from(queryVector).join(",")}]`;
    // Max-pool: one row per session, keeping the nearest chunk (lowest distance).
    const result = await this.pool.query<{ session_id: string; distance: number }>(
      `SELECT session_id, MIN(embedding <-> $1::vector) AS distance
       FROM session_embedding_chunks
       GROUP BY session_id
       ORDER BY distance
       LIMIT $2`,
      [vecStr, k],
    );
    return result.rows.map((r) => ({ sessionId: r.session_id, distance: r.distance }));
  }

  async keywordSearch(
    query: string,
    limit: number,
  ): Promise<ReadonlyArray<KeywordNeighbor>> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const tsquery = terms.map((t) => `'${t.replace(/'/g, "''")}'`).join(" | ");
    const k = Math.max(1, Math.trunc(limit));
    const result = await this.pool.query<{ session_id: string; score: number }>(
      `SELECT id AS session_id,
              ts_rank_cd(fts_vector, to_tsquery('english', $1)) AS score
       FROM sessions
       WHERE fts_vector @@ to_tsquery('english', $1)
       ORDER BY score DESC
       LIMIT $2`,
      [tsquery, k],
    );
    return result.rows.map((r) => ({ sessionId: r.session_id, score: r.score }));
  }

  async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    if (status === "idle") {
      throw new Error("Cannot persist derived status 'idle' — only active/closed/superseded");
    }
    await this.pool.query(
      "UPDATE sessions SET status = $1, updated_at = NOW() WHERE id = $2",
      [status, sessionId],
    );
  }

  async markSuperseded(predecessorId: string, successorId: string): Promise<void> {
    if (predecessorId === successorId) {
      throw new Error("A session cannot supersede itself");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const predExists = await client.query<{ c: string }>(
        "SELECT COUNT(*) AS c FROM sessions WHERE id = $1", [predecessorId],
      );
      if (Number(predExists.rows[0]?.c) === 0) {
        throw new Error(`predecessor session ${predecessorId} not found`);
      }
      const succExists = await client.query<{ c: string }>(
        "SELECT COUNT(*) AS c FROM sessions WHERE id = $1", [successorId],
      );
      if (Number(succExists.rows[0]?.c) === 0) {
        throw new Error(`successor session ${successorId} not found`);
      }
      await client.query(
        `DELETE FROM session_edges WHERE to_session = $1 AND kind = 'supersedes' AND from_session != $2`,
        [predecessorId, successorId],
      );
      await client.query(
        `INSERT INTO session_edges (from_session, to_session, kind)
         VALUES ($1, $2, 'supersedes')
         ON CONFLICT DO NOTHING`,
        [successorId, predecessorId],
      );
      await client.query(
        "UPDATE sessions SET status = 'superseded', updated_at = NOW() WHERE id = $1",
        [predecessorId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Mirrors SqliteSessionStore.recentWrites for the /live HTTP endpoint. */
  async recentWrites(limit: number): Promise<RecentWrite[]> {
    const result = await this.pool.query<RecentWrite>(
      `SELECT id, runtime, label, summary, created_at AS "createdAt"
       FROM sessions ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  /** Mirrors SqliteSessionStore.recentMarkers for the /live HTTP endpoint. */
  async recentMarkers(limit: number): Promise<RecentMarker[]> {
    const result = await this.pool.query<RecentMarker>(
      `SELECT m.session_id AS "sessionId", m.kind, m.text, s.label, s.created_at AS "createdAt"
       FROM markers m
       JOIN sessions s ON s.id = m.session_id
       ORDER BY s.created_at DESC, m.position ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  /**
   * Atomic session + entities + markers + edges + embedding ingest.
   * Mirrors SqliteSessionStore.insertSession but in PG async style.
   * The supersedence edge and optional facts are handled by the caller
   * (Storage.withTransaction for the facts path).
   */
  async insertSession(
    record: IngestRecord,
    embedder: import("@ports/llm-client.js").LLMClient | null = null,
    supersedes: string | null = null,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO sessions (
           id, runtime, runtime_session_id, started_at, ended_at, duration_min,
           label, summary, body, status, transcript_kind, transcript_path,
           transcript_offset, transcript_length
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           ended_at = EXCLUDED.ended_at,
           duration_min = EXCLUDED.duration_min,
           label = EXCLUDED.label,
           summary = EXCLUDED.summary,
           body = EXCLUDED.body,
           status = EXCLUDED.status,
           updated_at = NOW()`,
        [
          record.id, record.runtime, record.runtimeSessionId,
          record.startedAt, record.endedAt, record.durationMin,
          record.label, record.summary, record.body,
          record.status === "idle" ? "active" : record.status,
          record.transcriptKind, record.transcriptPath,
          record.transcriptOffset, record.transcriptLength,
        ],
      );

      await client.query("DELETE FROM markers WHERE session_id = $1", [record.id]);
      for (let i = 0; i < record.decisions.length; i++) {
        await client.query(
          "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'decision', $2, $3)",
          [record.id, record.decisions[i]!.trim(), i],
        );
      }
      for (let i = 0; i < record.openQuestions.length; i++) {
        await client.query(
          "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'open', $2, $3)",
          [record.id, record.openQuestions[i]!.trim(), i],
        );
      }

      for (const raw of record.entities) {
        const name = raw.trim();
        if (!name) continue;
        await client.query(
          `INSERT INTO entities (canonical, type, status, source, first_seen_session, last_seen_session, session_count)
           VALUES ($1, 'candidate', 'candidate', 'auto-detected', $2, $2, 0)
           ON CONFLICT (canonical) DO UPDATE SET
             last_seen_session = $2,
             session_count = entities.session_count + 1,
             updated_at = NOW()`,
          [name, record.id],
        );
        await client.query(
          "INSERT INTO session_entities (session_id, entity_canonical) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [record.id, name],
        );
      }

      if (supersedes) {
        await client.query(
          `INSERT INTO session_edges (from_session, to_session, kind)
           VALUES ($1, $2, 'supersedes') ON CONFLICT DO NOTHING`,
          [record.id, supersedes],
        );
        await client.query(
          "UPDATE sessions SET status = 'superseded', updated_at = NOW() WHERE id = $1",
          [supersedes],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (embedder) {
      const chunks = chunkSessionText({
        label: record.label,
        summary: record.summary,
        body: record.body,
      });
      await this.pool.query(
        `DELETE FROM session_embedding_chunks WHERE session_id = $1`,
        [record.id],
      );
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const text = chunks[chunkIdx]!;
        if (!text) continue;
        try {
          const { vector } = await embedder.embed(text, "document");
          const vecStr = `[${Array.from(vector).join(",")}]`;
          const ins = await this.pool.query<{ chunk_id: number }>(
            `INSERT INTO session_embedding_chunks (session_id, chunk_idx, embedding)
             VALUES ($1, $2, $3::vector) RETURNING chunk_id`,
            [record.id, chunkIdx, vecStr],
          );
          const chunkId = ins.rows[0]!.chunk_id;
          await this.pool.query(
            "INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES ($1, $2, $3)",
            [chunkId, record.id, chunkIdx],
          );
        } catch {
          // Per-chunk failure must not abort subsequent chunks.
        }
      }
    }
  }

  /** @internal test-only session seed. */
  async insertSessionForTest(session: Session): Promise<void> {
    const status: SessionStatus = session.status === "idle" ? "active" : session.status;
    await this.pool.query(
      `INSERT INTO sessions (id, runtime, runtime_session_id, started_at, ended_at,
         duration_min, label, summary, body, status, transcript_kind, transcript_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        session.id, session.runtime, session.runtimeSessionId, session.startedAt,
        session.endedAt, session.durationMin, session.label, session.summary,
        session.body, status, session.transcriptKind, session.transcriptPath,
      ],
    );
    for (const e of session.entities) {
      await this.pool.query(
        "INSERT INTO entities (canonical, type, status) VALUES ($1, 'candidate', 'active') ON CONFLICT DO NOTHING",
        [e],
      );
      await this.pool.query(
        "INSERT INTO session_entities (session_id, entity_canonical) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [session.id, e],
      );
    }
    for (let i = 0; i < session.decisions.length; i++) {
      await this.pool.query(
        "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'decision', $2, $3)",
        [session.id, session.decisions[i], i],
      );
    }
    for (let i = 0; i < session.open.length; i++) {
      await this.pool.query(
        "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'open', $2, $3)",
        [session.id, session.open[i], i],
      );
    }
  }

  private async loadEntities(ids: ReadonlyArray<string>): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const result = await this.pool.query<{ session_id: string; entity_canonical: string }>(
      `SELECT session_id, entity_canonical FROM session_entities
       WHERE session_id IN (${placeholders}) ORDER BY session_id`,
      [...ids],
    );
    const out = new Map<string, string[]>();
    for (const r of result.rows) {
      const list = out.get(r.session_id);
      if (list) list.push(r.entity_canonical);
      else out.set(r.session_id, [r.entity_canonical]);
    }
    return out;
  }

  private async loadMarkers(
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, { decisions: string[]; open: string[] }>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const result = await this.pool.query<{ session_id: string; kind: "decision" | "open"; text: string }>(
      `SELECT session_id, kind, text FROM markers
       WHERE session_id IN (${placeholders}) ORDER BY session_id, position`,
      [...ids],
    );
    const out = new Map<string, { decisions: string[]; open: string[] }>();
    for (const r of result.rows) {
      let bucket = out.get(r.session_id);
      if (!bucket) { bucket = { decisions: [], open: [] }; out.set(r.session_id, bucket); }
      if (r.kind === "decision") bucket.decisions.push(r.text);
      else bucket.open.push(r.text);
    }
    return out;
  }

  private async loadEdges(
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, { supersededBy: string | null; supersedes: string[] }>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const result = await this.pool.query<{ from_session: string; to_session: string }>(
      `SELECT from_session, to_session FROM session_edges
       WHERE kind = 'supersedes'
         AND (from_session IN (${placeholders}) OR to_session IN (${placeholders}))`,
      [...ids, ...ids],
    );
    const out = new Map<string, { supersededBy: string | null; supersedes: string[] }>();
    for (const id of ids) out.set(id, { supersededBy: null, supersedes: [] });
    for (const r of result.rows) {
      out.get(r.from_session)?.supersedes.push(r.to_session);
      const toEntry = out.get(r.to_session);
      if (toEntry) toEntry.supersededBy = r.from_session;
    }
    return out;
  }
}

function rowToSession(
  row: SessionRow,
  entitiesById: Map<string, string[]>,
  markersById: Map<string, { decisions: string[]; open: string[] }>,
  edges?: { supersededBy: string | null; supersedes: string[] },
): Session {
  const m = markersById.get(row.id);
  return {
    id: row.id,
    runtime: row.runtime,
    runtimeSessionId: row.runtime_session_id ?? "",
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMin: row.duration_min,
    label: row.label,
    summary: row.summary,
    status: row.status,
    transcriptKind: row.transcript_kind ?? "",
    transcriptPath: row.transcript_path,
    body: row.body ?? "",
    entities: entitiesById.get(row.id) ?? [],
    decisions: m?.decisions ?? [],
    open: m?.open ?? [],
    ...(edges !== undefined
      ? { supersededBy: edges.supersededBy, supersedes: edges.supersedes }
      : {}),
  };
}
```

- [x] **Step 2: Typecheck**

```bash
cd "~/nlm-memory" && npx tsc -p tsconfig.json --noEmit 2>&1 | grep "pg-session-store"
```

Expected: no output.

---

## Task 6: PgStorage

**Files:**
- Create: `src/core/storage/pg-storage.ts`

- [x] **Step 1: Write PgStorage**

Create `src/core/storage/pg-storage.ts`:

```typescript
/**
 * PgStorage — canonical Storage adapter for PostgreSQL + pgvector.
 *
 * Implements the Storage port (init/close/withTransaction). withTransaction
 * uses the write-queue pattern from pg-tx-context.ts: the sync callback
 * queues SQL ops, then PgStorage flushes the queue inside a single
 * BEGIN/COMMIT after the callback returns.
 *
 * pgPool() is a deprecated escape hatch for callers not yet ported to the
 * Storage interface (SourceRegistry, ProviderRegistry, actions-log,
 * scheduler). Tracked for removal in #215a (PG branch).
 */

import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage, StorageContext } from "@ports/storage.js";
import { PgFactStore } from "./pg-fact-store.js";
import { PgSessionStore } from "./pg-session-store.js";
import { PgTxBoundFactStore, PgTxBoundSessionStore } from "./pg-tx-context.js";

export interface PgStorageOptions {
  readonly connectionString: string;
  readonly migrationsDir: string;
}

export class PgStorage implements Storage {
  readonly facts: PgFactStore;
  readonly sessions: PgSessionStore;
  private readonly pool: Pool;
  private inTxn = false;

  private constructor(pool: Pool) {
    this.pool = pool;
    this.facts = new PgFactStore(pool);
    this.sessions = new PgSessionStore(pool);
  }

  static create(opts: PgStorageOptions): PgStorage {
    const pool = new Pool({ connectionString: opts.connectionString });
    const storage = new PgStorage(pool);
    // Stash migrationsDir for init()
    (storage as unknown as { _migrationsDir: string })._migrationsDir = opts.migrationsDir;
    return storage;
  }

  async init(): Promise<void> {
    const migrationsDir = (this as unknown as { _migrationsDir: string })._migrationsDir;
    const sql = readFileSync(join(migrationsDir, "001_initial.sql"), "utf8");
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async withTransaction<T>(fn: (ctx: StorageContext) => T): Promise<T> {
    if (this.inTxn) {
      throw new Error("PgStorage.withTransaction does not support nesting");
    }
    this.inTxn = true;
    const queue: import("./pg-tx-context.js").QueuedOp[] = [];
    const txFacts = new PgTxBoundFactStore(queue);
    const txSessions = new PgTxBoundSessionStore(queue);
    const ctx: StorageContext = { facts: txFacts, sessions: txSessions };
    let result: T;
    try {
      result = fn(ctx);
    } finally {
      this.inTxn = false;
    }
    if (queue.length > 0) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        for (const op of queue) {
          await client.query(op.sql, op.params as unknown[]);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    return result;
  }

  /**
   * @deprecated Escape hatch for callers not yet ported to the Storage
   * interface (SourceRegistry, ProviderRegistry, actions-log, scheduler).
   * Tracked for removal in #215a (PG branch).
   */
  pgPool(): Pool {
    return this.pool;
  }
}
```

- [x] **Step 2: Typecheck the whole server**

```bash
cd "~/nlm-memory" && npx tsc -p tsconfig.json --noEmit 2>&1 | head -30
```

Expected: no errors in pg-storage.ts, pg-fact-store.ts, pg-session-store.ts, or pg-tx-context.ts. (Other unrelated errors are okay at this stage; they get fixed in later tasks.)

---

## Task 7: Fact-Store Contract Test with PG Harness

**Files:**
- Create: `tests/integration/fact-store.pg.test.ts`

This file wires the existing `runFactStoreContract` against `PgStorage`. It uses `NLM_PG_TEST_URL` to find a running PG instance and skips gracefully if absent.

- [x] **Step 1: Write the PG harness**

Create `tests/integration/fact-store.pg.test.ts`:

```typescript
/**
 * PgStorage adapter — FactStore contract.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL to a
 * connection string, e.g.:
 *   export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"
 *
 * Skips when the env var is absent. Tables are truncated between tests for
 * isolation; schema is applied on first setup() call.
 */

import { describe, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runFactStoreContract } from "../../tests/contract/fact-store.contract.js";
import type { FactStoreContractHarness } from "../../tests/contract/fact-store.contract.js";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import type { Session } from "../../src/shared/types.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

const harness: FactStoreContractHarness = {
  name: "PgStorage",

  async setup(): Promise<Storage> {
    if (!PG_TEST_URL) throw new Error("NLM_PG_TEST_URL not set");
    const storage = PgStorage.create({
      connectionString: PG_TEST_URL,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    await (storage as PgStorage).pgPool().query(TRUNCATE_SQL);
    return storage;
  },

  async teardown(storage: Storage): Promise<void> {
    await storage.close();
  },

  async seedSession(storage: Storage, session: Session): Promise<void> {
    await (storage as PgStorage).sessions.insertSessionForTest(session);
  },
};

describe.skipIf(!PG_TEST_URL)(
  "PgStorage: fact-store contract",
  () => {
    runFactStoreContract(harness);
  },
);
```

- [x] **Step 2: Run contract test against real PG (if available)**

If you have a local PG instance:

```bash
export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"
cd "~/nlm-memory"
npm run test:integration -- --reporter=verbose 2>&1 | grep -A2 "PgStorage"
```

Expected: all `FactStore contract: PgStorage` tests pass. If `NLM_PG_TEST_URL` is not set, the suite skips with 0 tests.

- [x] **Step 3: Run the full test suite to verify nothing regressed**

```bash
cd "~/nlm-memory" && npm test 2>&1 | tail -5
```

Expected: same pass count as before this task.

---

## Task 8: Storage Contract Test + PG Harness

**Files:**
- Create: `tests/contract/storage.contract.ts`
- Create: `tests/integration/storage.pg.test.ts`

The storage contract tests `withTransaction` atomicity: either all ops in a callback commit or all roll back.

- [x] **Step 1: Write the storage contract**

Create `tests/contract/storage.contract.ts`:

```typescript
/**
 * Storage withTransaction contract test.
 *
 * Verifies atomicity: a callback that writes two facts either commits both
 * or rolls back both. Adapter-agnostic — wire any Storage implementation
 * via StorageContractHarness.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

export interface StorageContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
  seedSession(storage: Storage, session: import("../../src/shared/types.js").Session): Promise<void>;
}

export function runStorageContract(h: StorageContractHarness): void {
  describe(`Storage contract: ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await h.setup();
      await h.seedSession(storage, makeSession({ id: "sess_a" }));
      await h.seedSession(storage, makeSession({ id: "sess_b" }));
    });

    afterEach(async () => {
      await h.teardown(storage);
    });

    it("commits both writes when callback succeeds", async () => {
      await storage.withTransaction((ctx) => {
        ctx.facts.ingestSessionFacts("sess_a", [
          makeFact({ id: "f1", subject: "alpha", sourceSessionId: "sess_a" }),
        ]);
        ctx.facts.ingestSessionFacts("sess_b", [
          makeFact({ id: "f2", subject: "beta", sourceSessionId: "sess_b" }),
        ]);
      });
      expect(await storage.facts.getById("f1")).not.toBeNull();
      expect(await storage.facts.getById("f2")).not.toBeNull();
    });

    it("rolls back all writes when callback throws", async () => {
      await storage.facts.insert(
        makeFact({ id: "existing", subject: "pre", sourceSessionId: "sess_a" }),
      );
      await expect(
        storage.withTransaction((ctx) => {
          ctx.facts.ingestSessionFacts("sess_a", [
            makeFact({ id: "new", subject: "alpha", sourceSessionId: "sess_a" }),
          ]);
          throw new Error("deliberate rollback");
        }),
      ).rejects.toThrow("deliberate rollback");
      // "existing" survives; "new" was never committed.
      expect(await storage.facts.getById("existing")).not.toBeNull();
      expect(await storage.facts.getById("new")).toBeNull();
    });

    it("rejects nested withTransaction calls", async () => {
      await expect(
        storage.withTransaction((_outer) => {
          void storage.withTransaction((_inner) => {
            // no-op
          });
        }),
      ).rejects.toThrow(/nesting/i);
    });
  });
}
```

- [x] **Step 2: Write the PG harness**

Create `tests/integration/storage.pg.test.ts`:

```typescript
import { describe } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runStorageContract } from "../../tests/contract/storage.contract.js";
import type { StorageContractHarness } from "../../tests/contract/storage.contract.js";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import type { Session } from "../../src/shared/types.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

const harness: StorageContractHarness = {
  name: "PgStorage",
  async setup(): Promise<Storage> {
    if (!PG_TEST_URL) throw new Error("NLM_PG_TEST_URL not set");
    const storage = PgStorage.create({
      connectionString: PG_TEST_URL,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    await (storage as PgStorage).pgPool().query(TRUNCATE_SQL);
    return storage;
  },
  async teardown(storage: Storage): Promise<void> {
    await storage.close();
  },
  async seedSession(storage: Storage, session: Session): Promise<void> {
    await (storage as PgStorage).sessions.insertSessionForTest(session);
  },
};

describe.skipIf(!PG_TEST_URL)(
  "PgStorage: storage contract",
  () => {
    runStorageContract(harness);
  },
);
```

- [x] **Step 3: Run storage contract against PG (if available)**

```bash
cd "~/nlm-memory"
npm run test:integration -- --reporter=verbose 2>&1 | grep -A2 "storage contract"
```

Expected: `Storage contract: PgStorage` — 3 passing.

- [x] **Step 4: Run the full test suite**

```bash
cd "~/nlm-memory" && npm test 2>&1 | tail -5
```

Expected: same pass count, plus however many new PG tests ran.

- [x] **Step 5: Commit**

```bash
cd "~/nlm-memory"
git add migrations/pg/001_initial.sql \
        src/core/storage/pg-tx-context.ts \
        src/core/storage/pg-fact-store.ts \
        src/core/storage/pg-session-store.ts \
        src/core/storage/pg-storage.ts \
        tests/contract/storage.contract.ts \
        tests/integration/fact-store.pg.test.ts \
        tests/integration/storage.pg.test.ts \
        package.json package-lock.json
git commit -m "feat(#216): PgStorage + PgFactStore + PgSessionStore adapters with contract tests"
```

---

## Task 9: PG-Native SourceRegistry

**Files:**
- Modify: `src/core/sources/source-registry.ts`

Add a `PgSourceRegistry` class alongside the existing `SourceRegistry`. Same CRUD logic; takes `pg.Pool` instead of `better-sqlite3.Database`.

- [x] **Step 1: Read the current SourceRegistry**

Read `src/core/sources/source-registry.ts` (lines 60–end) to understand the full CRUD surface before writing the PG version.

- [x] **Step 2: Add PgSourceRegistry to the file**

At the bottom of `src/core/sources/source-registry.ts`, add:

```typescript
import type { Pool } from "pg";

/**
 * PgSourceRegistry — CRUD over `sources` for the PG storage path.
 * Takes a pg.Pool instead of better-sqlite3.Database.
 * API mirrors SourceRegistry exactly so callers swap the constructor arg.
 */
export class PgSourceRegistry {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<SourceRow[]> {
    const result = await this.pool.query<{
      id: number; kind: SourceKind; name: string; path_or_url: string | null;
      runtime_label: string; parse_config: string; enabled: boolean;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, kind, name, path_or_url, runtime_label, parse_config,
              enabled, created_at, updated_at
       FROM sources ORDER BY id`,
    );
    return result.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      pathOrUrl: r.path_or_url,
      runtimeLabel: r.runtime_label,
      parseConfig: JSON.parse(r.parse_config) as Record<string, unknown>,
      enabled: r.enabled,
      token: null,
      hasToken: false,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async get(id: number): Promise<SourceRow | null> {
    const result = await this.pool.query<{
      id: number; kind: SourceKind; name: string; path_or_url: string | null;
      runtime_label: string; parse_config: string; enabled: boolean;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, kind, name, path_or_url, runtime_label, parse_config,
              enabled, created_at, updated_at
       FROM sources WHERE id = $1`,
      [id],
    );
    if (!result.rows[0]) return null;
    const r = result.rows[0];
    return {
      id: r.id, kind: r.kind, name: r.name, pathOrUrl: r.path_or_url,
      runtimeLabel: r.runtime_label,
      parseConfig: JSON.parse(r.parse_config) as Record<string, unknown>,
      enabled: r.enabled, token: null, hasToken: false,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  async insert(input: SourceInsert): Promise<SourceRow> {
    const result = await this.pool.query<{ id: number; created_at: string; updated_at: string }>(
      `INSERT INTO sources (kind, name, path_or_url, runtime_label, parse_config, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at, updated_at`,
      [
        input.kind, input.name, input.pathOrUrl ?? null, input.runtimeLabel,
        JSON.stringify(input.parseConfig ?? {}), input.enabled ?? true,
      ],
    );
    const row = result.rows[0]!;
    return {
      id: row.id, kind: input.kind, name: input.name, pathOrUrl: input.pathOrUrl ?? null,
      runtimeLabel: input.runtimeLabel,
      parseConfig: input.parseConfig ?? {},
      enabled: input.enabled ?? true,
      token: null, hasToken: false,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async update(id: number, patch: SourceUpdate): Promise<SourceRow | null> {
    const sets: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [];
    let idx = 1;
    if (patch.name !== undefined) { sets.push(`name = $${idx++}`); params.push(patch.name); }
    if ("pathOrUrl" in patch) { sets.push(`path_or_url = $${idx++}`); params.push(patch.pathOrUrl); }
    if (patch.runtimeLabel !== undefined) { sets.push(`runtime_label = $${idx++}`); params.push(patch.runtimeLabel); }
    if (patch.parseConfig !== undefined) { sets.push(`parse_config = $${idx++}`); params.push(JSON.stringify(patch.parseConfig)); }
    if (patch.enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(patch.enabled); }
    if (sets.length === 1) return this.get(id);
    params.push(id);
    await this.pool.query(
      `UPDATE sources SET ${sets.join(", ")} WHERE id = $${idx}`,
      params,
    );
    return this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM sources WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async seedDefaults(): Promise<void> {
    // Same preset seeding as SQLite SourceRegistry.seedDefaults().
    // Uses ON CONFLICT DO NOTHING so re-runs are idempotent.
    const presets: Array<{ kind: SourceKind; name: string; path_or_url: string | null; runtime_label: string }> = [
      { kind: "claude-code", name: "claude-code", path_or_url: null, runtime_label: "claude-code" },
      { kind: "hermes", name: "hermes", path_or_url: null, runtime_label: "hermes" },
      { kind: "pi", name: "pi", path_or_url: null, runtime_label: "pi" },
    ];
    for (const p of presets) {
      await this.pool.query(
        `INSERT INTO sources (kind, name, path_or_url, runtime_label, parse_config, enabled)
         VALUES ($1, $2, $3, $4, '{}', TRUE)
         ON CONFLICT (name) DO NOTHING`,
        [p.kind, p.name, p.path_or_url, p.runtime_label],
      );
    }
  }
}
```

- [x] **Step 2: Typecheck**

```bash
cd "~/nlm-memory" && npx tsc -p tsconfig.json --noEmit 2>&1 | grep "source-registry"
```

Expected: no output.

---

## Task 10: PG-Native ProviderRegistry

**Files:**
- Modify: `src/core/providers/provider-registry.ts`

- [x] **Step 1: Read the current ProviderRegistry**

Read `src/core/providers/provider-registry.ts` to see the full CRUD surface.

- [x] **Step 2: Add PgProviderRegistry to the file**

At the bottom of `src/core/providers/provider-registry.ts`, add:

```typescript
import type { Pool } from "pg";

/**
 * PgProviderRegistry — CRUD over `providers` for the PG storage path.
 * API mirrors ProviderRegistry exactly.
 */
export class PgProviderRegistry {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<ProviderRow[]> {
    const result = await this.pool.query<{
      id: number; kind: ProviderKind; name: string; base_url: string | null;
      api_key: string | null; default_model: string | null; enabled: boolean;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, kind, name, base_url, api_key, default_model, enabled, created_at, updated_at
       FROM providers ORDER BY id`,
    );
    return result.rows.map((r) => ({
      id: r.id, kind: r.kind, name: r.name, baseUrl: r.base_url,
      apiKey: null, hasApiKey: r.api_key !== null,
      defaultModel: r.default_model, enabled: r.enabled,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  async get(id: number): Promise<ProviderRow | null> {
    const result = await this.pool.query<{
      id: number; kind: ProviderKind; name: string; base_url: string | null;
      api_key: string | null; default_model: string | null; enabled: boolean;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, kind, name, base_url, api_key, default_model, enabled, created_at, updated_at
       FROM providers WHERE id = $1`,
      [id],
    );
    if (!result.rows[0]) return null;
    const r = result.rows[0];
    return {
      id: r.id, kind: r.kind, name: r.name, baseUrl: r.base_url,
      apiKey: null, hasApiKey: r.api_key !== null,
      defaultModel: r.default_model, enabled: r.enabled,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  async getSecret(id: number): Promise<string | null> {
    const result = await this.pool.query<{ api_key: string | null }>(
      "SELECT api_key FROM providers WHERE id = $1", [id],
    );
    return result.rows[0]?.api_key ?? null;
  }

  async insert(input: ProviderInsert): Promise<ProviderRow> {
    const result = await this.pool.query<{ id: number; created_at: string; updated_at: string }>(
      `INSERT INTO providers (kind, name, base_url, api_key, default_model, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at, updated_at`,
      [input.kind, input.name, input.baseUrl ?? null, input.apiKey ?? null, input.defaultModel ?? null, input.enabled ?? true],
    );
    const row = result.rows[0]!;
    return {
      id: row.id, kind: input.kind, name: input.name, baseUrl: input.baseUrl ?? null,
      apiKey: null, hasApiKey: input.apiKey !== undefined && input.apiKey !== null,
      defaultModel: input.defaultModel ?? null, enabled: input.enabled ?? true,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async update(id: number, patch: ProviderUpdate): Promise<ProviderRow | null> {
    const sets: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [];
    let idx = 1;
    if (patch.name !== undefined) { sets.push(`name = $${idx++}`); params.push(patch.name); }
    if ("baseUrl" in patch) { sets.push(`base_url = $${idx++}`); params.push(patch.baseUrl); }
    if ("apiKey" in patch) { sets.push(`api_key = $${idx++}`); params.push(patch.apiKey); }
    if ("defaultModel" in patch) { sets.push(`default_model = $${idx++}`); params.push(patch.defaultModel); }
    if (patch.enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(patch.enabled); }
    if (sets.length === 1) return this.get(id);
    params.push(id);
    await this.pool.query(`UPDATE providers SET ${sets.join(", ")} WHERE id = $${idx}`, params);
    return this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM providers WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
```

Note: `ProviderInsert` and `ProviderUpdate` interfaces come from the existing file. Match the exact interface shapes in provider-registry.ts when writing this.

- [x] **Step 3: Typecheck**

```bash
cd "~/nlm-memory" && npx tsc -p tsconfig.json --noEmit 2>&1 | grep "provider-registry"
```

Expected: no output.

---

## Task 11: PG-Native ActionsLog

**Files:**
- Modify: `src/core/actions/actions-log.ts`

The existing `writeAction`, `writeActionsBatch`, `undoAction`, `listActions` functions all take `better-sqlite3.Database`. Add PG counterparts. No changes to the existing functions.

- [x] **Step 1: Add PG-native actions functions to actions-log.ts**

Append to the bottom of `src/core/actions/actions-log.ts`:

```typescript
import type { Pool } from "pg";

/**
 * PG counterparts for writeAction, writeActionsBatch, undoAction, listActions.
 * Same API as their SQLite counterparts but take pg.Pool.
 */

export async function writeActionPg(pool: Pool, input: ActionInput): Promise<string> {
  const id = makeActionId();
  const payload = input.payload ? JSON.stringify(input.payload) : null;
  await pool.query(
    `INSERT INTO actions (id, timestamp, kind, subject_type, subject_id, payload, actor, runtime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, new Date().toISOString(), input.kind, input.subjectType, input.subjectId,
     payload, input.actor ?? "user", input.runtime ?? "api"],
  );
  return id;
}

export async function writeActionsBatchPg(pool: Pool, inputs: ReadonlyArray<ActionInput>): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids: string[] = [];
    for (const input of inputs) {
      const id = makeActionId();
      const payload = input.payload ? JSON.stringify(input.payload) : null;
      await client.query(
        `INSERT INTO actions (id, timestamp, kind, subject_type, subject_id, payload, actor, runtime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, new Date().toISOString(), input.kind, input.subjectType, input.subjectId,
         payload, input.actor ?? "user", input.runtime ?? "api"],
      );
      ids.push(id);
    }
    await client.query("COMMIT");
    return ids;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function undoActionPg(pool: Pool, actionId: string): Promise<UndoResult | null> {
  const target = await pool.query<{ id: string; kind: string; subject_type: string; subject_id: string }>(
    "SELECT id, kind, subject_type, subject_id FROM actions WHERE id = $1 AND reverted_by IS NULL",
    [actionId],
  );
  if (!target.rows[0]) return null;
  const t = target.rows[0];
  const undoId = makeActionId();
  const undoPayload = JSON.stringify({ undone_kind: t.kind, undone_subject: `${t.subject_type}:${t.subject_id}` });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO actions (id, timestamp, kind, subject_type, subject_id, payload, actor, runtime)
       VALUES ($1, $2, 'undo', 'action', $3, $4, 'user', 'api')`,
      [undoId, new Date().toISOString(), actionId, undoPayload],
    );
    await client.query("UPDATE actions SET reverted_by = $1 WHERE id = $2", [undoId, actionId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { undoId, originalKind: t.kind };
}

export async function listActionsPg(
  pool: Pool,
  opts: { limit?: number; subjectId?: string; kind?: string } = {},
): Promise<ActionRow[]> {
  const limit = opts.limit ?? 100;
  const where: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (opts.subjectId) { where.push(`subject_id = $${idx++}`); params.push(opts.subjectId); }
  if (opts.kind) { where.push(`kind = $${idx++}`); params.push(opts.kind); }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  const result = await pool.query<ActionRow & { payload: string | null }>(
    `SELECT id, timestamp, kind, subject_type, subject_id, payload, actor, runtime, reverted_by
     FROM actions ${whereSql}
     ORDER BY timestamp DESC LIMIT $${idx}`,
    params,
  );
  return result.rows.map((r) => ({
    ...r,
    payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null,
  }));
}
```

Note: `makeActionId` is a private function in actions-log.ts. If it's not exported, you'll need to either export it or inline the logic in the PG functions. Check the existing file and match accordingly.

- [x] **Step 2: Typecheck**

```bash
cd "~/nlm-memory" && npx tsc -p tsconfig.json --noEmit 2>&1 | grep "actions-log"
```

Expected: no output.

---

## Task 12: PG-Native adapter_state (scan-once + scheduler)

**Files:**
- Modify: `src/core/scheduler/scan-once.ts`
- Modify: `src/core/scheduler/scheduler.ts`

The scheduler uses `adapter_state` for resumability. `scanOnce` and `recordFailed` take a `better-sqlite3.Database`. Add PG overloads.

- [x] **Step 1: Read scan-once.ts**

Read `src/core/scheduler/scan-once.ts` fully to understand the adapter_state SQL before writing the PG version.

- [x] **Step 2: Add PG overloads to scan-once.ts**

Append to the bottom of `src/core/scheduler/scan-once.ts`:

```typescript
import type { Pool } from "pg";

/**
 * PG counterpart of scanOnce. Takes pg.Pool instead of better-sqlite3.Database.
 * Logic mirrors the SQLite version exactly; only the SQL dialect changes.
 */
export async function scanOncePg(
  adapter: TranscriptAdapter,
  idleMinutes: number,
  pool: Pool,
): Promise<ScanResult[]> {
  const stateRows = await pool.query<{
    source_path: string;
    file_size: number | null;
    session_id: string | null;
    failure_count: number;
  }>(
    "SELECT source_path, file_size, session_id, COALESCE(failure_count, 0) AS failure_count FROM adapter_state WHERE adapter_name = $1",
    [adapter.name],
  );
  const stateMap = new Map(stateRows.rows.map((r) => [
    r.source_path,
    { fileSize: r.file_size, sessionId: r.session_id, failureCount: r.failure_count },
  ]));

  const paths = await adapter.discoverPaths();
  const results: ScanResult[] = [];

  for (const sourcePath of paths) {
    const state = stateMap.get(sourcePath);
    if (state && state.failureCount >= MAX_CLASSIFY_FAILURES) {
      const currentSize = await getFileSize(sourcePath);
      if (currentSize === state.fileSize) continue;
      await pool.query(
        "UPDATE adapter_state SET failure_count = 0 WHERE adapter_name = $1 AND source_path = $2",
        [adapter.name, sourcePath],
      );
    }

    const offset = 0; // PG path always starts from 0; session resumability via session_id
    const chunks = await adapter.parse(sourcePath, offset, idleMinutes);
    for (const chunk of chunks) {
      const prior = stateMap.get(sourcePath);
      const supersedes = prior?.sessionId !== chunk.id ? prior?.sessionId ?? null : null;
      results.push({ chunk, supersedes });
    }

    if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1]!;
      await pool.query(
        `INSERT INTO adapter_state (adapter_name, source_path, last_offset, file_size, session_id, failure_count)
         VALUES ($1, $2, 0, $3, $4, 0)
         ON CONFLICT (adapter_name, source_path) DO UPDATE SET
           file_size = EXCLUDED.file_size,
           session_id = EXCLUDED.session_id,
           failure_count = 0,
           last_processed_at = NOW()`,
        [adapter.name, sourcePath, await getFileSize(sourcePath), lastChunk.id],
      );
    }
  }

  return results;
}

export async function recordFailedPg(pool: Pool, adapterName: string, sourcePath: string): Promise<void> {
  await pool.query(
    `INSERT INTO adapter_state (adapter_name, source_path, last_offset, failure_count)
     VALUES ($1, $2, 0, 1)
     ON CONFLICT (adapter_name, source_path) DO UPDATE SET
       failure_count = adapter_state.failure_count + 1,
       last_processed_at = NOW()`,
    [adapterName, sourcePath],
  );
}
```

Note: `TranscriptAdapter`, `ScanResult`, `MAX_CLASSIFY_FAILURES`, and `getFileSize` are already defined in scan-once.ts. Reference them by name — do not re-define.

- [x] **Step 3: Update scheduler.ts to use PG overloads when pgPool() is available**

In `src/core/scheduler/scheduler.ts`, find the `tick()` method. The current code calls:
```typescript
results = await scanOnce(adapter, this.opts.idleMinutes, this.opts.store.rawDb());
```
and:
```typescript
recordFailed(this.opts.store.rawDb(), adapter.name, chunk.sourcePath);
```

Change those lines to:

```typescript
// In tick() — replace scanOnce call:
const pgPool = (this.opts.store as import("../storage/pg-storage.js").PgStorage | SqliteStorage).pgPool?.();
if (pgPool) {
  results = await scanOncePg(adapter, this.opts.idleMinutes, pgPool);
} else {
  results = await scanOnce(adapter, this.opts.idleMinutes, (this.opts.store as SqliteStorage).rawDb());
}
```

And for `recordFailed`:
```typescript
const pgPool2 = (this.opts.store as import("../storage/pg-storage.js").PgStorage | SqliteStorage).pgPool?.();
if (pgPool2) {
  recordFailedPg(pgPool2, adapter.name, chunk.sourcePath);
} else {
  recordFailed((this.opts.store as SqliteStorage).rawDb(), adapter.name, chunk.sourcePath);
}
```

Also do the same for the direct `rawDb().prepare(...)` failure_count query — replace with an async PG query or use the state from `scanOncePg`'s own state map.

- [x] **Step 4: Typecheck**

```bash
cd "~/nlm-memory" && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "scan-once|scheduler"
```

Expected: no output.

---

## Task 13: Bootstrap Env Wiring (nlm.ts + app.ts)

**Files:**
- Modify: `src/cli/nlm.ts`
- Modify: `src/http/app.ts`

When `NLM_PG_URL` is set, the CLI and HTTP server use `PgStorage` instead of `SqliteStorage`. The `HttpDeps.liveStore` type is widened to accept `PgSessionStore` alongside `SqliteSessionStore`.

- [x] **Step 1: Update HttpDeps in app.ts**

In `src/http/app.ts`, find the `HttpDeps` interface. Change:
```typescript
readonly liveStore?: SqliteSessionStore;
```
to:
```typescript
readonly liveStore?: SqliteSessionStore | PgSessionStore;
```

Add `import { PgSessionStore } from "../core/storage/pg-session-store.js";` at the top of app.ts with the other storage imports.

Also update the `sources` and `providers` field types in `HttpDeps` to accept the PG variants:
```typescript
readonly sources?: SourceRegistry | PgSourceRegistry;
readonly providers?: ProviderRegistry | PgProviderRegistry;
```

- [x] **Step 2: Add storage factory helper to nlm.ts**

In `src/cli/nlm.ts`, after the existing imports, add:

```typescript
import { PgStorage } from "../core/storage/pg-storage.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PG_MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

async function buildStorage(dbPath: string): Promise<SqliteStorage | PgStorage> {
  const pgUrl = process.env["NLM_PG_URL"];
  if (pgUrl) {
    const storage = PgStorage.create({ connectionString: pgUrl, migrationsDir: PG_MIGRATIONS_DIR });
    await storage.init();
    return storage;
  }
  return SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
}
```

- [x] **Step 3: Replace SqliteStorage.create() calls in the start command**

Find the `start` command in `src/cli/nlm.ts` where `SqliteStorage.create(...)` is called. Replace with `await buildStorage(dbPath)`.

Do the same for any other command that creates a `SqliteStorage` instance but could also work with PG (e.g., `recall`, `stats`). Leave commands that specifically need file-level operations (like `backup`, `restore`) SQLite-only.

- [x] **Step 4: Wire PG registries when PG storage is active**

Find where `new SourceRegistry(storage.rawDb())` and `new ProviderRegistry(storage.rawDb())` are called in `nlm.ts`. Replace with:

```typescript
const sources = storage instanceof PgStorage
  ? new PgSourceRegistry(storage.pgPool())
  : new SourceRegistry((storage as SqliteStorage).rawDb());
const providers = storage instanceof PgStorage
  ? new PgProviderRegistry(storage.pgPool())
  : new ProviderRegistry((storage as SqliteStorage).rawDb());
```

- [x] **Step 5: Wire PG actions when PG storage is active**

Find where `writeAction(deps.liveStore.rawDb(), ...)` etc. are called in `app.ts`. Wrap each in a branch:

```typescript
// In app.ts route handlers:
const pool = (deps.liveStore as PgSessionStore | undefined) instanceof PgSessionStore
  ? (deps.liveStore as PgSessionStore).pool
  : null;
if (pool) {
  const id = await writeActionPg(pool, parsed);
  // ...
} else {
  const id = writeAction((deps.liveStore as SqliteSessionStore).rawDb(), parsed);
  // ...
}
```

- [x] **Step 6: Typecheck the full project**

```bash
cd "~/nlm-memory" && npx tsc -p tsconfig.json --noEmit 2>&1 | head -30
```

Expected: no errors.

- [x] **Step 7: Run the full test suite**

```bash
cd "~/nlm-memory" && npm test
```

Expected: all existing tests pass. PG contract tests pass if `NLM_PG_TEST_URL` is set.

- [x] **Step 8: Smoke test with PG (if available)**

```bash
export NLM_PG_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"
cd "~/nlm-memory"
node dist/cli/nlm.js start --port 3941 &
sleep 2
curl -s http://localhost:3941/api/recall/stats | python3 -m json.tool
kill %1
```

Expected: JSON with `{ "total": 0, "hit_rate": 0, ... }` — daemon started, responded, shut down cleanly.

- [x] **Step 9: Commit**

```bash
cd "~/nlm-memory"
git add \
  src/core/sources/source-registry.ts \
  src/core/providers/provider-registry.ts \
  src/core/actions/actions-log.ts \
  src/core/scheduler/scan-once.ts \
  src/core/scheduler/scheduler.ts \
  src/cli/nlm.ts \
  src/http/app.ts
git commit -m "feat(#216): PG-native registries + bootstrap env wiring (NLM_PG_URL)"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| PgStorage implements Storage port | Tasks 3–6 |
| PgFactStore passes runFactStoreContract unchanged | Task 7 |
| withTransaction atomicity contract | Task 8 |
| pgPool() escape hatch | Task 6 |
| PG-native SourceRegistry + ProviderRegistry | Tasks 9–10 |
| PG-native ActionsLog | Task 11 |
| PG-native adapter_state / scheduler | Task 12 |
| NLM_PG_URL env-based selection | Task 13 |

All requirements covered.

### Placeholder scan

- Task 9 Step 2: "Note: `ProviderInsert` and `ProviderUpdate` interfaces come from the existing file." — This is a genuine cross-reference note, not a placeholder. The interfaces are already defined and must be matched.
- Task 12 Step 3: The exact line numbers in scheduler.ts are not given — the implementer must read the file and find the rawDb() calls. This is intentional; Task 12 Step 1 says to read the file first.

### Type consistency

- `PgTxBoundFactStore` implements `FactStore` ✓ (same interface as `SqliteFactStore`)
- `PgTxBoundSessionStore` implements `SessionStore` ✓
- `PgStorage.pgPool()` returns `pg.Pool` ✓ (used in Tasks 9–12)
- `PgSessionStore.insertSessionForTest` called from harness `seedSession` ✓
- `RecentWrite` and `RecentMarker` imported from `sqlite-session-store.ts` in `pg-session-store.ts` ✓ (same shape, no need to redefine)
- `IngestRecord` imported from `sqlite-session-store.ts` in `pg-session-store.ts` ✓
