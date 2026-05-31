# FactStore + Storage Port Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `Storage` port that owns lifecycle + atomic unit-of-work, lift `upsertEmbedding` onto the `FactStore` port, extract a backend-agnostic contract test, and migrate all callers to a single `SqliteStorage` construction path — so that NLM Teams (#216–218) can add a Postgres+pgvector adapter without forking core logic.

**Architecture:** Mem0-style repository pattern. `Storage.withTransaction(ctx => ...)` is the only atomicity primitive core/ knows about; the SQLite adapter implements it via a single shared `better-sqlite3` connection, the future PG adapter via a pooled txn. The fact ingest write path (DELETE + insertMany + deterministic supersedence) moves from a private method on `SqliteSessionStore` to a port method on `FactStore` (`ingestSessionFacts`) so it runs under any backend. Contract tests freeze current SQLite behavior as the spec; the PG adapter must pass them unchanged.

**Tech Stack:** TypeScript, vitest, better-sqlite3 + sqlite-vec (today), pgvector (future). No new runtime dependencies.

---

## File Structure

**New files:**
- `src/ports/storage.ts` — `Storage`, `StorageContext` interfaces.
- `src/core/storage/sqlite-storage.ts` — `SqliteStorage` class, owns connection, exposes both stores + `withTransaction` + `init/close`. Includes `rawDb()` escape hatch (deprecated, for not-yet-ported callers).
- `tests/contract/fact-store.contract.ts` — `runFactStoreContract(harness)` function. Pure, no module-level `describe`.
- `tests/contract/storage.contract.ts` — `runStorageContract(harness)` for `withTransaction` semantics (commit, rollback, no-nesting).

**Modified files:**
- `src/ports/fact-store.ts` — add `upsertEmbedding(factId, vector): Promise<void>` and `ingestSessionFacts(sessionId, facts): Promise<void>` to the interface.
- `src/core/storage/sqlite-fact-store.ts` — implement new port methods; convert existing sync `upsertEmbedding` to async; **delete** `insertManyInTxn`.
- `src/core/storage/sqlite-session-store.ts` — replace `applyFactsInTxn` private method's body with a call to `factStore.ingestSessionFacts`; remove the private helper; `insertSession` switches its inner txn to use the storage-level handle (still works because both stores share the connection).
- `tests/integration/sqlite-fact-store.test.ts` — rewrite to call `runFactStoreContract` with a SQLite harness.
- **7 production caller files** (migrate to `SqliteStorage`):
  - `src/install/setup.ts:313`
  - `src/cli/supersede.ts:361`
  - `src/cli/nlm.ts:146, :292, :1008, :1032, :1150, :1171` (6 call sites in one file)
- **~30 test files** (mechanical migration to `SqliteStorage`):
  - Full list in Task 7 step 1.

**Out of scope (tracked separately as #215a — "Audit non-FactStore port leaks"):**
- `src/core/scheduler/scheduler.ts`, `src/core/facts/backfill-facts.ts`, `src/http/app.ts` actions endpoints, `src/core/sources/source-registry.ts`, `src/core/providers/provider-registry.ts`, `src/core/actions/{actions-log,overlay}.ts`. These continue using `storage.rawDb()` as a typed, deprecated escape hatch.

---

## Pre-Flight (must do before Task 1)

- [ ] **Step 1: Create isolated worktree**

Use `superpowers:using-git-worktrees` to open a worktree on branch `feat/factstore-port-storage`. All subsequent work happens in that worktree. The plan file should be copied into the worktree's `docs/plans/` so it travels with the branch.

- [ ] **Step 2: Baseline test run on `main`**

Run: `npm test`
Expected: All tests pass. Record exact pass count (e.g. "412 passed, 0 failed") for comparison after each task. If any test is failing on `main`, **stop and fix it first** — this plan assumes a green baseline.

- [ ] **Step 3: Verify build is clean on `main`**

Run: `npm run build`
Expected: Exit 0, no TS errors. If broken, fix before starting.

---

## Task 1: Extract Contract Test Against Existing Code

**Goal:** Lift the SQLite integration test into a reusable contract function with no behavior change. Proves the assertions are backend-agnostic. After this task, the test suite still uses the original `SqliteFactStore` construction; nothing else has moved.

**Files:**
- Create: `tests/contract/fact-store.contract.ts`
- Modify: `tests/integration/sqlite-fact-store.test.ts`

- [ ] **Step 1: Read the existing test to inventory behaviors**

Run: `cat tests/integration/sqlite-fact-store.test.ts | grep -E "^\s+it\("`
Expected: A list of `it("...")` titles (~20+ assertions). Write the list into a temp file `/tmp/factstore-behaviors.txt` for reference.

- [ ] **Step 2: Create the harness interface and contract entry point**

Create `tests/contract/fact-store.contract.ts` with this exact content:

```typescript
/**
 * Backend-agnostic contract test for the FactStore port.
 *
 * Each adapter integration test imports runFactStoreContract and supplies a
 * harness that builds a fresh, migrated, empty Storage instance per test.
 * Identical assertions run against every backend — that is the only proof
 * that a new adapter (e.g. Postgres) is behaviorally equivalent to SQLite.
 *
 * Do NOT put module-level describe() blocks here. The function shape lets
 * each integration test file own its own describe naming.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

export interface FactStoreContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
}

export function runFactStoreContract(h: FactStoreContractHarness): void {
  describe(`FactStore contract — ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await h.setup();
      await storage.withTransaction(async (ctx) => {
        await ctx.sessions.insert(makeSession({ id: "sess_parent", label: "Parent" }));
      });
    });

    afterEach(async () => {
      await h.teardown(storage);
    });

    // BEHAVIOR PORTS — see Steps 3-N below for each test body.
  });
}
```

**Important:** This file will not compile yet — it imports `src/ports/storage.ts` which doesn't exist, and `Storage.withTransaction` / `Storage.sessions` are not defined. That's expected. Task 2 fixes the import; Task 3 fixes the implementation. We're staging the test shape first so Task 2/3 have a target.

- [ ] **Step 3: Run the contract test file to confirm it fails for the expected reason**

Run: `npx vitest run tests/contract/fact-store.contract.ts 2>&1 | head -30`
Expected: TypeScript compile error or "Cannot find module '../../src/ports/storage.js'". This proves the harness wiring is correct; we just need the port. **Do not proceed if the failure is different.**

- [ ] **Step 4: Commit the harness skeleton**

```bash
git add tests/contract/fact-store.contract.ts
git commit -m "test(factstore): scaffold backend-agnostic contract harness

Lifts the SQLite integration test shape into a reusable function.
Empty body — behavior assertions ported in Task 1 follow-up steps
after the Storage port lands (Task 2)."
```

- [ ] **Step 5: Defer behavior porting until Task 3 is complete**

The behavior assertions (steps 6-N of what would have been this task) can only run once `SqliteStorage` exists. They land as the final commit of Task 3.

---

## Task 2: Add Storage Port + Extend FactStore Port

**Goal:** Define the port shape with no implementation. Build must still pass — additive only.

**Files:**
- Create: `src/ports/storage.ts`
- Modify: `src/ports/fact-store.ts`

- [ ] **Step 1: Write the failing build check (sanity)**

Run: `npm run build`
Expected: Exit 0 (baseline). Record this as the "before" state for Step 5.

- [ ] **Step 2: Create the Storage port**

Create `src/ports/storage.ts` with this exact content:

```typescript
/**
 * Storage — top-level handle for NLM's fact + session corpus. Owns lifecycle
 * (init/close) and the atomic unit-of-work primitive (withTransaction).
 *
 * Read paths use the bare .facts / .sessions handles. Writes that must
 * commit together — session+facts+embeddings on ingest, supersedence chain
 * edits — go through withTransaction so the adapter chooses its own
 * atomicity mechanism (single SQLite connection, PG transaction, etc.)
 * without core/ knowing which backend it's talking to.
 *
 * See docs/plans/2026-05-30-factstore-storage-port.md.
 */

import type { FactStore } from "./fact-store.js";
import type { SessionStore } from "./session-store.js";

export interface StorageContext {
  readonly facts: FactStore;
  readonly sessions: SessionStore;
}

export interface Storage {
  readonly facts: FactStore;
  readonly sessions: SessionStore;

  /**
   * Run `fn` inside an adapter-defined transaction. The handles on the
   * provided StorageContext are bound to that transaction; reads and writes
   * through them see one another, and either all commit or all roll back.
   * Outer handles (storage.facts, storage.sessions) MUST NOT be used inside
   * `fn` — adapters may enforce this with a runtime check.
   *
   * Nested calls are not supported. Adapters throw on nested invocation.
   */
  withTransaction<T>(fn: (ctx: StorageContext) => Promise<T> | T): Promise<T>;

  /** Apply migrations / install extensions. Idempotent. */
  init(): Promise<void>;

  /** Release the underlying connection or pool. */
  close(): Promise<void>;
}
```

- [ ] **Step 3: Extend the FactStore port with two new methods**

Edit `src/ports/fact-store.ts`. After the existing `markSuperseded(...)` method (line 72), and before `listForRecall` (line 80), add these two methods:

```typescript
  /**
   * Insert or replace the embedding vector for a fact. Vector dimension is
   * fixed by the embedding model (nomic-embed-text → 768) and validated by
   * the adapter. Best-effort at the call site: ingest traps errors so an
   * unreachable embedder doesn't roll back the surrounding transaction.
   */
  upsertEmbedding(factId: string, vector: Float32Array): Promise<void>;

  /**
   * Atomic session-scoped fact write: delete prior facts for this session,
   * insert the new set, then apply deterministic supersedence on any
   * (subject, predicate) collision against existing non-superseded facts
   * from other sessions. Must run inside a transaction (the caller wraps
   * with Storage.withTransaction). See Section 2 of factstore-design.md
   * and the original applyFactsInTxn comment in sqlite-session-store.ts
   * for the ordering rationale (insert before supersedence-UPDATE).
   *
   * Replaces the SqliteSessionStore.applyFactsInTxn private helper as a
   * port-level operation so any FactStore backend can implement it.
   */
  ingestSessionFacts(
    sessionId: string,
    facts: ReadonlyArray<import("@shared/types.js").Fact>,
  ): Promise<void>;
```

- [ ] **Step 4: Run build — expect failure pointing at SqliteFactStore**

Run: `npm run build`
Expected: TS error in `src/core/storage/sqlite-fact-store.ts` along the lines of "Class 'SqliteFactStore' incorrectly implements interface 'FactStore'. Missing properties: ingestSessionFacts, upsertEmbedding (signature mismatch — sync vs async)". This is the right failure.

- [ ] **Step 5: Add minimal stub implementations to keep the build green**

Edit `src/core/storage/sqlite-fact-store.ts`. Find the existing `upsertEmbedding(factId, vector): void` method (around line 233). Change its signature to `async`:

```typescript
  async upsertEmbedding(factId: string, vector: Float32Array): Promise<void> {
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?").run(factId);
    this.db
      .prepare("INSERT INTO fact_embeddings (fact_id, embedding) VALUES (?, ?)")
      .run(factId, blob);
  }
```

Then add a stub `ingestSessionFacts` near the end of the class, **above** the `private insertStmt()` helper. Real implementation comes in Task 4 — for now we just need the interface satisfied:

```typescript
  async ingestSessionFacts(
    sessionId: string,
    facts: ReadonlyArray<Fact>,
  ): Promise<void> {
    // Stubbed in Task 2 to satisfy the FactStore interface; real
    // transactional behavior lands in Task 4 when SqliteStorage exists
    // and SqliteSessionStore.applyFactsInTxn is removed.
    throw new Error(
      "ingestSessionFacts not yet wired — call insertMany + manual supersedence",
    );
  }
```

- [ ] **Step 6: Run build — must now succeed**

Run: `npm run build`
Expected: Exit 0. If any callers of the old sync `upsertEmbedding` exist, the build will flag them as missing `await`. Search and fix:

Run: `grep -rn "upsertEmbedding" src/ tests/ | grep -v ".test.ts" | grep -v "// "`
Expected: All call sites use `await` or are inside `.then(...)`. The known caller is `SqliteSessionStore.embedFacts` (private helper called from `insertSession` and `insertFactsForSession`). Add `await` if missing.

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: Same pass count as Pre-Flight Step 2. No new failures. The contract test scaffold from Task 1 still fails to import — that's expected and tracked by Task 3.

- [ ] **Step 8: Commit**

```bash
git add src/ports/storage.ts src/ports/fact-store.ts src/core/storage/sqlite-fact-store.ts
git commit -m "feat(ports): add Storage port + lift upsertEmbedding/ingestSessionFacts onto FactStore

Defines the unit-of-work primitive (Storage.withTransaction) for the
upcoming Postgres adapter (#216-218). Additive — no caller migrates yet.
upsertEmbedding becomes async (was sync); ingestSessionFacts is stubbed
and wired in Task 4 when SqliteStorage exists.

Plan: docs/plans/2026-05-30-factstore-storage-port.md (Task 2)"
```

---

## Task 3: Implement SqliteStorage

**Goal:** One canonical construction path. Old constructors keep working — Task 5/6 migrate callers. Contract test (Task 1) wires up and goes green here.

**Files:**
- Create: `src/core/storage/sqlite-storage.ts`
- Modify: `tests/integration/sqlite-fact-store.test.ts`
- Modify: `tests/contract/fact-store.contract.ts` (port behavior assertions)

- [ ] **Step 1: Create SqliteStorage class**

Create `src/core/storage/sqlite-storage.ts` with this content:

```typescript
/**
 * SqliteStorage — canonical Storage adapter for better-sqlite3 + sqlite-vec.
 *
 * Owns the connection. Builds SqliteSessionStore and SqliteFactStore over
 * that single connection so writes commit on one WAL writer (the SQLite
 * atomicity model). withTransaction wraps better-sqlite3's synchronous
 * `db.transaction()` API and re-runs it inside an async shell so callers
 * can await async work inside the callback (e.g. an embedder call) — but
 * note that the db txn itself is synchronous; do not call long-running
 * async work inside withTransaction or the txn will hold its write lock.
 *
 * rawDb() is a deprecated escape hatch for callers that still use direct
 * better-sqlite3 — scheduler, http actions endpoints, backfill-facts,
 * source/provider registries. Tracked for removal in #215a.
 */

import type Database from "better-sqlite3";
import type { Storage, StorageContext } from "@ports/storage.js";
import { SqliteFactStore } from "./sqlite-fact-store.js";
import { SqliteSessionStore } from "./sqlite-session-store.js";

export interface SqliteStorageOptions {
  readonly dbPath: string;
  readonly migrationsDir: string;
}

export class SqliteStorage implements Storage {
  readonly sessions: SqliteSessionStore;
  readonly facts: SqliteFactStore;
  private inTxn = false;

  private constructor(
    sessions: SqliteSessionStore,
    facts: SqliteFactStore,
  ) {
    this.sessions = sessions;
    this.facts = facts;
  }

  static create(opts: SqliteStorageOptions): SqliteStorage {
    const sessions = new SqliteSessionStore(opts);
    const facts = new SqliteFactStore(sessions.rawDb());
    return new SqliteStorage(sessions, facts);
  }

  async init(): Promise<void> {
    // SqliteSessionStore runs migrations in its constructor today; this is
    // a no-op for the SQLite adapter. Reserved for backends (Postgres)
    // that need explicit init.
  }

  async close(): Promise<void> {
    this.sessions.close();
  }

  async withTransaction<T>(
    fn: (ctx: StorageContext) => Promise<T> | T,
  ): Promise<T> {
    if (this.inTxn) {
      throw new Error("SqliteStorage.withTransaction does not support nesting");
    }
    this.inTxn = true;
    try {
      // better-sqlite3 transactions are synchronous; we run fn synchronously
      // via a thunk and resolve outside. Async work inside fn that awaits
      // I/O will execute, but the SQLite write lock is held for the whole
      // transaction body — keep callbacks tight.
      let captured: T | undefined;
      let err: unknown = null;
      const txn = this.sessions.rawDb().transaction(() => {
        const ctx: StorageContext = { facts: this.facts, sessions: this.sessions };
        const maybe = fn(ctx);
        if (maybe instanceof Promise) {
          // Async fn inside a sync txn: throw — design says callbacks must
          // be sync or pure-CPU async. Real async work (embedder) lives
          // outside the txn, mirroring the original insertSession pattern.
          throw new Error(
            "withTransaction callback returned a Promise — keep txn bodies synchronous",
          );
        }
        captured = maybe;
      });
      try {
        txn();
      } catch (e) {
        err = e;
      }
      if (err) throw err;
      return captured as T;
    } finally {
      this.inTxn = false;
    }
  }

  /**
   * @deprecated SQLite-only escape hatch for callers not yet ported to the
   * Storage interface. Tracked for removal in #215a. Do not use in new code.
   */
  rawDb(): Database.Database {
    return this.sessions.rawDb();
  }
}
```

**Design note for the executing engineer:** the synchronous-txn-callback constraint is intentional. The original `insertSession` puts embedding work *outside* the txn for exactly the same reason (line ~300 of `sqlite-session-store.ts`: "Embedding is best-effort and lives outside the txn so a slow Ollama doesn't block the row commit"). Task 4 honors this same pattern — embedding stays outside `withTransaction`.

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Exit 0.

- [ ] **Step 3: Wire the contract test against SqliteStorage**

Edit `tests/integration/sqlite-fact-store.test.ts`. Replace its entire content with this harness wire-up:

```typescript
/**
 * SqliteFactStore conformance to the FactStore port contract.
 *
 * The actual assertions live in tests/contract/fact-store.contract.ts so
 * the Postgres adapter (#216-218) can run them unchanged.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { runFactStoreContract } from "../contract/fact-store.contract.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const tmpDirs = new WeakMap<SqliteStorage, string>();

runFactStoreContract({
  name: "sqlite",
  async setup() {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-facts-"));
    const storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    tmpDirs.set(storage, tmp);
    return storage;
  },
  async teardown(storage) {
    const tmp = tmpDirs.get(storage);
    await storage.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  },
});
```

- [ ] **Step 4: Port behavior assertions into the contract file**

Open the OLD `tests/integration/sqlite-fact-store.test.ts` from git (`git show HEAD:tests/integration/sqlite-fact-store.test.ts > /tmp/old-fact-test.ts`). Copy each `it("...", async () => { ... })` block into the contract describe in `tests/contract/fact-store.contract.ts`. Translate references:

| Old reference | New reference |
|---|---|
| `factStore.X(...)` | `storage.facts.X(...)` |
| `sessionStore.X(...)` | `storage.sessions.X(...)` |
| `sessionStore.insertSessionForTest(s)` | `await storage.withTransaction(ctx => ctx.sessions.insert(s))` (or keep using the test-only helper if it exists on the underlying class — see Step 5) |
| Direct `db.prepare(...)` SQL pokes | Keep in `sqlite-fact-store.test.ts` as SQLite-specific tests outside the contract. |

For any test that pokes `sessionStore.rawDb()` directly to assert internal state, **do not port it into the contract** — keep those as SQLite-specific tests in a new file `tests/integration/sqlite-fact-store.internal.test.ts`. The contract is behavior-only.

- [ ] **Step 5: Decide what to do with `insertSessionForTest`**

Run: `grep -rn "insertSessionForTest" src/ tests/`
Expected: Used in test fixtures only. If yes, keep the method on `SqliteSessionStore` as a public test affordance (it bypasses the normal ingest path) and document it as `@internal — test-only`. The contract test uses `withTransaction(ctx => ctx.sessions.insert(...))` instead, which exercises the production path.

- [ ] **Step 6: Run the contract test**

Run: `npx vitest run tests/integration/sqlite-fact-store.test.ts -t "FactStore contract"`
Expected: All ported assertions pass. If any fail, **fix the contract test or the SqliteStorage wiring — do not change SqliteFactStore behavior.** A failing assertion here means the contract is wrong about current SQLite behavior.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: Same pass count as Pre-Flight Step 2. The contract test replaces the old integration test 1:1, plus any preserved SQLite-internal tests.

- [ ] **Step 8: Commit**

```bash
git add src/core/storage/sqlite-storage.ts tests/integration/sqlite-fact-store.test.ts tests/contract/fact-store.contract.ts
git add tests/integration/sqlite-fact-store.internal.test.ts 2>/dev/null || true
git commit -m "feat(storage): implement SqliteStorage + wire contract test

SqliteStorage owns the better-sqlite3 connection and exposes Storage
port (init/close/withTransaction). Existing SqliteSessionStore and
SqliteFactStore constructors still work — Task 5/6 migrate callers.

Integration test is now thin: the FactStore contract lives in
tests/contract/fact-store.contract.ts. SQLite-internal assertions
(raw-db pokes) stay in sqlite-fact-store.internal.test.ts.

Plan: docs/plans/2026-05-30-factstore-storage-port.md (Task 3)"
```

---

## Task 4: Wire ingestSessionFacts + Remove insertManyInTxn

**Goal:** The behaviorally tricky one. Move the DELETE + insertMany + supersedence loop from `SqliteSessionStore.applyFactsInTxn` to `SqliteFactStore.ingestSessionFacts`. Re-route `insertSession` and `insertFactsForSession` through `withTransaction`. Delete `insertManyInTxn` and its only caller.

**Files:**
- Modify: `src/core/storage/sqlite-fact-store.ts`
- Modify: `src/core/storage/sqlite-session-store.ts`
- Modify: `tests/contract/fact-store.contract.ts` (add ingestSessionFacts assertions)

- [ ] **Step 1: Add failing contract assertions for `ingestSessionFacts`**

Edit `tests/contract/fact-store.contract.ts`. Inside the existing describe block, add:

```typescript
    describe("ingestSessionFacts", () => {
      it("inserts new facts attributed to the session", async () => {
        const f1 = makeFact({ id: "f1", subject: "alpha", predicate: "color", value: "red", sourceSessionId: "sess_parent" });
        await storage.withTransaction(async (ctx) => {
          await ctx.facts.ingestSessionFacts("sess_parent", [f1]);
        });
        const stored = await storage.facts.getById("f1");
        expect(stored?.value).toBe("red");
      });

      it("deletes prior facts for the same session before re-ingesting", async () => {
        const original = makeFact({ id: "orig", subject: "alpha", predicate: "color", value: "red", sourceSessionId: "sess_parent" });
        await storage.withTransaction(async (ctx) => {
          await ctx.facts.ingestSessionFacts("sess_parent", [original]);
        });
        const replacement = makeFact({ id: "new", subject: "alpha", predicate: "color", value: "blue", sourceSessionId: "sess_parent" });
        await storage.withTransaction(async (ctx) => {
          await ctx.facts.ingestSessionFacts("sess_parent", [replacement]);
        });
        expect(await storage.facts.getById("orig")).toBeNull();
        expect((await storage.facts.getById("new"))?.value).toBe("blue");
      });

      it("supersedes a current fact from another session on (subject,predicate) collision", async () => {
        await storage.withTransaction(async (ctx) => {
          await ctx.sessions.insert(makeSession({ id: "sess_other" }));
        });
        const older = makeFact({ id: "older", subject: "alpha", predicate: "color", value: "red", sourceSessionId: "sess_other" });
        const newer = makeFact({ id: "newer", subject: "alpha", predicate: "color", value: "blue", sourceSessionId: "sess_parent" });
        await storage.withTransaction(async (ctx) => {
          await ctx.facts.ingestSessionFacts("sess_other", [older]);
        });
        await storage.withTransaction(async (ctx) => {
          await ctx.facts.ingestSessionFacts("sess_parent", [newer]);
        });
        const olderFetched = await storage.facts.getById("older");
        expect(olderFetched?.supersededBy).toBe("newer");
        const current = await storage.facts.findCurrent("alpha", "color");
        expect(current?.id).toBe("newer");
      });

      it("is a no-op for empty fact array but still deletes prior session facts", async () => {
        const f = makeFact({ id: "to-delete", subject: "alpha", predicate: "color", value: "red", sourceSessionId: "sess_parent" });
        await storage.withTransaction(async (ctx) => {
          await ctx.facts.ingestSessionFacts("sess_parent", [f]);
        });
        await storage.withTransaction(async (ctx) => {
          await ctx.facts.ingestSessionFacts("sess_parent", []);
        });
        expect(await storage.facts.getById("to-delete")).toBeNull();
      });
    });
```

- [ ] **Step 2: Run the new contract assertions — expect failures**

Run: `npx vitest run tests/integration/sqlite-fact-store.test.ts -t "ingestSessionFacts"`
Expected: All four tests fail with "ingestSessionFacts not yet wired" (the stub from Task 2 Step 5).

- [ ] **Step 3: Implement ingestSessionFacts on SqliteFactStore**

Open `src/core/storage/sqlite-fact-store.ts`. Replace the stub `ingestSessionFacts` with the real implementation (logic transcribed from `SqliteSessionStore.applyFactsInTxn`, currently at the section starting "Sync core of the fact-ingest block"):

```typescript
  async ingestSessionFacts(
    sessionId: string,
    facts: ReadonlyArray<Fact>,
  ): Promise<void> {
    this.db.prepare("DELETE FROM facts WHERE source_session_id = ?").run(sessionId);
    if (facts.length === 0) return;

    const insertStmt = this.insertStmt();
    for (const f of facts) insertStmt.run(this.toRow(f));

    const findCollisionStmt = this.db.prepare<
      [string, string, string],
      { id: string }
    >(`
      SELECT id
      FROM facts
      WHERE subject = ?
        AND predicate = ?
        AND superseded_by IS NULL
        AND id != ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const markSupersededStmt = this.db.prepare(
      "UPDATE facts SET superseded_by = ? WHERE id = ?",
    );
    for (const f of facts) {
      const collision = findCollisionStmt.get(f.subject, f.predicate, f.id);
      if (collision && collision.id !== f.id) {
        markSupersededStmt.run(f.id, collision.id);
      }
    }
  }
```

**Important:** this method does NOT open its own transaction — callers wrap with `Storage.withTransaction`. The original `applyFactsInTxn` carried the same contract ("Runs inside an EXISTING transaction — opens no txn of its own"). The synchronous SQL is fine inside `withTransaction` because better-sqlite3 transactions are synchronous.

- [ ] **Step 4: Run new contract assertions — expect pass**

Run: `npx vitest run tests/integration/sqlite-fact-store.test.ts -t "ingestSessionFacts"`
Expected: All four tests pass. If supersedence test fails, double-check that `applyFactsInTxn`'s ordering (insert-then-update) was preserved.

- [ ] **Step 5: Replace SqliteSessionStore's call site**

Open `src/core/storage/sqlite-session-store.ts`. Find the `applyFactsInTxn` private method (the body shown in earlier reads). Replace its entire body with:

```typescript
  private applyFactsInTxn(
    sessionId: string,
    factStore: SqliteFactStore,
    facts: ReadonlyArray<Fact>,
  ): void {
    // Synchronously drive ingestSessionFacts — this runs inside the
    // caller's better-sqlite3 transaction (insertSession or
    // insertFactsForSession). ingestSessionFacts is declared async on
    // the port for backend-agnosticism, but the SQLite implementation
    // is all synchronous SQL, so awaiting a resolved Promise is safe
    // inside the txn (microtask runs before the txn callback returns).
    void factStore.ingestSessionFacts(sessionId, facts);
  }
```

**Wait — that's wrong.** `void` discards the promise and any thrown error inside `ingestSessionFacts` would not propagate. The correct pattern: keep the method body inline (transcribe ingestSessionFacts logic here too) OR make `applyFactsInTxn` async and `await` it — but the outer `db.transaction()` callback is sync.

Resolution: since the txn callback must be sync, and we want one source of truth for the logic, the cleanest move is to **delete `applyFactsInTxn` entirely** and inline its replacement at the two call sites (insertSession and insertFactsForSession). The replacement uses the same private SQLite operations that `SqliteFactStore.ingestSessionFacts` uses — duplicated logic across the two classes is acceptable here because the SqliteFactStore version is what the contract test exercises and what the PG adapter will mirror; the SqliteSessionStore inlined version is a SQLite-internal performance optimization that avoids the async wrapper.

**Concrete change:** at each of the two call sites in `sqlite-session-store.ts` (search for `this.applyFactsInTxn(`), replace the call with:

```typescript
        // Inlined version of SqliteFactStore.ingestSessionFacts —
        // SqliteSessionStore needs sync execution inside the better-sqlite3
        // txn callback. The async port method exists for backend-agnostic
        // callers (any code outside this class uses storage.withTransaction
        // + ctx.facts.ingestSessionFacts). See Task 4 design note.
        const db = this.db;
        db.prepare("DELETE FROM facts WHERE source_session_id = ?").run(record.id);
        if (factSink.facts.length > 0) {
          factSink.factStore.insertManyInTxn(factSink.facts);  // <-- REMOVE in Step 6
          const findCollisionStmt = db.prepare<[string, string, string], { id: string }>(`
            SELECT id FROM facts
            WHERE subject = ? AND predicate = ? AND superseded_by IS NULL AND id != ?
            ORDER BY created_at DESC LIMIT 1
          `);
          const markSupersededStmt = db.prepare(
            "UPDATE facts SET superseded_by = ? WHERE id = ?",
          );
          for (const f of factSink.facts) {
            const collision = findCollisionStmt.get(f.subject, f.predicate, f.id);
            if (collision && collision.id !== f.id) {
              markSupersededStmt.run(f.id, collision.id);
            }
          }
        }
```

**Then delete the private `applyFactsInTxn` method.**

**Note on `insertManyInTxn`:** Step 6 removes it; for now the inlined block above still calls it. Sequencing matters — leave the call in place until Step 6 swaps it for a direct `insertStmt` loop.

- [ ] **Step 6: Replace `insertManyInTxn` calls with direct inserts, then delete the method**

In both inlined blocks (insertSession and insertFactsForSession), replace `factSink.factStore.insertManyInTxn(factSink.facts);` with:

```typescript
          for (const f of factSink.facts) {
            (factSink.factStore as SqliteFactStore).insertRowInTxn(f);
          }
```

Then in `src/core/storage/sqlite-fact-store.ts`:

a. **Delete the `insertManyInTxn` method** (lines ~60-69, the one defined as `insertManyInTxn(facts: ...): void`).

b. **Add a new minimal sync helper** `insertRowInTxn` that the inlined blocks above call:

```typescript
  /**
   * @internal — sync row insert for use inside an already-open better-sqlite3
   * transaction. Used only by SqliteSessionStore's inlined ingest blocks
   * (which require sync execution inside the txn callback). External callers
   * use insertMany() or ingestSessionFacts() via Storage.withTransaction.
   */
  insertRowInTxn(fact: Fact): void {
    this.insertStmt().run(this.toRow(fact));
  }
```

- [ ] **Step 7: Run build**

Run: `npm run build`
Expected: Exit 0. Any "insertManyInTxn does not exist" error means a call site was missed — grep and fix:

Run: `grep -rn "insertManyInTxn" src/ tests/`
Expected: Zero matches.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: Same pass count as Pre-Flight Step 2, **plus the four new ingestSessionFacts assertions**. Specifically watch `tests/integration/fact-supersedence.test.ts`, `tests/integration/backfill-facts.test.ts`, `tests/integration/mcp.test.ts` — these exercise the ingest write path most heavily. If any fail, **stop and re-design** rather than loosening assertions.

- [ ] **Step 9: Commit**

```bash
git add src/core/storage/sqlite-fact-store.ts src/core/storage/sqlite-session-store.ts tests/contract/fact-store.contract.ts
git commit -m "feat(factstore): implement ingestSessionFacts + remove insertManyInTxn

Lifts the DELETE+insert+supersedence loop from SqliteSessionStore.applyFactsInTxn
to a port-level method on FactStore. SQLite session-store call sites inline
a sync version of the same logic (better-sqlite3 txn callbacks must be sync).
External callers reach the same behavior via Storage.withTransaction +
ctx.facts.ingestSessionFacts.

Contract test now covers all four supersedence-edge behaviors; the PG
adapter (#216-218) inherits the same proof of correctness.

Plan: docs/plans/2026-05-30-factstore-storage-port.md (Task 4)"
```

---

## Task 5: Migrate Production Callers

**Goal:** Replace the 7 production `new SqliteSessionStore({...})` / `new SqliteFactStore(...)` construction sites with `SqliteStorage.create(...)`. Callers that need `rawDb()` get it via `storage.rawDb()`.

**Files (call sites with exact line numbers from baseline):**
- `src/install/setup.ts:313`
- `src/cli/supersede.ts:361`
- `src/cli/nlm.ts:146, :152-155 (factStore + sources + providers), :292, :1008, :1032, :1150, :1171`

- [ ] **Step 1: Migrate `src/install/setup.ts`**

Open the file, find the existing line:
```typescript
    const store = new SqliteSessionStore({ dbPath: opts.dbPath, migrationsDir: opts.migrationsDir });
```

Replace with:
```typescript
    const storage = SqliteStorage.create({ dbPath: opts.dbPath, migrationsDir: opts.migrationsDir });
    await storage.init();
    const store = storage.sessions;
```

Add the import at the top: `import { SqliteStorage } from "@core/storage/sqlite-storage.js";`. Search the rest of the function for any later use of `store.close()` — replace with `await storage.close();`.

- [ ] **Step 2: Build + targeted test**

Run: `npm run build && npx vitest run -t "setup"`
Expected: Build green, setup-related tests green.

- [ ] **Step 3: Migrate `src/cli/supersede.ts:361`**

Find the function returning `new SqliteSessionStore({...})`. Change the function to return `SqliteStorage` (and update its callers) OR return `storage.sessions` if the existing API contract is `SessionStore`. Inspect the calling code first:

Run: `grep -n "buildSessionStore\|getStore\|loadStore" src/cli/supersede.ts | head`
Expected: A small number of internal callers — pick the change shape that minimizes downstream edits.

- [ ] **Step 4: Build + targeted test**

Run: `npm run build && npx vitest run tests/integration/cli-supersede.test.ts`
Expected: Both green.

- [ ] **Step 5: Migrate `src/cli/nlm.ts` (6 call sites)**

For each of lines 146, 292, 1008, 1032, 1150, 1171: replace `new SqliteSessionStore({...})` with `SqliteStorage.create({...})` + `await storage.init()`. Use `storage.sessions`, `storage.facts`, `storage.rawDb()` as needed for the downstream code in each block.

The block at line 146-155 has the most refactor — it also constructs `SqliteFactStore`, `SourceRegistry`, `ProviderRegistry`. Pattern:

```typescript
  const storage = SqliteStorage.create({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
  const store = storage.sessions;
  const facts = storage.facts;
  const sources = new SourceRegistry(storage.rawDb());  // #215a — still raw
  const providers = new ProviderRegistry(storage.rawDb());  // #215a — still raw
```

Add `// TODO(#215a): replace storage.rawDb() with port methods` next to each `rawDb()` use.

- [ ] **Step 6: Build + targeted test**

Run: `npm run build && npx vitest run`
Expected: Full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/install/setup.ts src/cli/supersede.ts src/cli/nlm.ts
git commit -m "refactor(callers): migrate production code to SqliteStorage

All 8 production construction sites now go through SqliteStorage.create.
Leaky callers (SourceRegistry, ProviderRegistry, scheduler, http/app
actions endpoints, backfill-facts) keep using storage.rawDb() with
TODO(#215a) markers — tracked separately.

Old new SqliteSessionStore / new SqliteFactStore constructors remain
public for backward compat during the test migration in Task 6;
sealed @internal in Task 7.

Plan: docs/plans/2026-05-30-factstore-storage-port.md (Task 5)"
```

---

## Task 6: Migrate Test Callers

**Goal:** Mechanically migrate ~30 test files from `new SqliteSessionStore({...})` to `SqliteStorage.create({...})`. Tests that poke `rawDb()` for assertions keep doing so via `storage.rawDb()`.

**Files (all in `tests/integration/`):**

- [ ] **Step 1: Enumerate test files needing migration**

Run: `grep -rln "new SqliteSessionStore\|new SqliteFactStore" tests/`
Expected: A list of ~30 files. Write to `/tmp/test-migration-list.txt`.

- [ ] **Step 2: Dispatch an Explore subagent to produce a per-file migration plan**

Use the Explore agent (Sonnet) to read each file in the list and emit a per-file diff plan: what to replace, what assertions break if any, whether the file uses `rawDb()`. Output as a markdown table. Do this in one agent call to keep main-session context clean.

Prompt the Explore agent with:

> Read each file listed in /tmp/test-migration-list.txt. For each, report:
> 1. Construction pattern used (one of: `new SqliteSessionStore`, `new SqliteSessionStore + new SqliteFactStore`, `new SqliteSessionStore + new SqliteFactStore + rawDb pokes`).
> 2. The variable name(s) currently used (`store`, `sessionStore`, `factStore`).
> 3. Whether any test in the file calls a method that doesn't exist on the Storage port (would need to go through `storage.sessions` / `storage.facts`).
> Output as a markdown table.

- [ ] **Step 3: Apply migrations file-by-file in batches of 5**

For each file, apply the standard substitution:

```typescript
// Before
beforeEach(() => {
  store = new SqliteSessionStore({ dbPath, migrationsDir: MIGRATIONS_DIR });
});

// After
beforeEach(async () => {
  storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
  await storage.init();
  store = storage.sessions;  // or rename downstream to storage.sessions
});
```

After each batch of 5 files, run: `npm test`. **All tests must still pass before continuing to the next batch.** If a batch breaks tests, revert that batch and inspect — usually a `rawDb()` call needs to switch from `store.rawDb()` to `storage.rawDb()`.

- [ ] **Step 4: Final full run after all batches**

Run: `npm test`
Expected: Same pass count as Pre-Flight Step 2 plus the four new ingestSessionFacts assertions. Specifically:

Run: `grep -rln "new SqliteSessionStore\|new SqliteFactStore" tests/`
Expected: Zero matches (or only matches inside `tests/contract/` import-renames that didn't need migrating).

- [ ] **Step 5: Mark old constructors as `@internal`**

In `src/core/storage/sqlite-session-store.ts`, add this JSDoc above the constructor:

```typescript
  /**
   * @internal — Construct via SqliteStorage.create(...) instead. Direct
   * construction is preserved for the SqliteStorage adapter only; all
   * other callers should reach SessionStore via storage.sessions.
   */
```

Same treatment in `src/core/storage/sqlite-fact-store.ts` constructor:

```typescript
  /**
   * @internal — Construct via SqliteStorage.create(...) instead. Direct
   * construction is preserved for the SqliteStorage adapter only; all
   * other callers should reach FactStore via storage.facts.
   */
```

- [ ] **Step 6: Run build + full test suite one final time**

Run: `npm run build && npm test`
Expected: Build green, full test suite green, contract test green.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/ src/core/storage/sqlite-session-store.ts src/core/storage/sqlite-fact-store.ts
git commit -m "refactor(tests): migrate all test sites to SqliteStorage

All ~30 integration tests now construct storage via SqliteStorage.create.
Old SqliteSessionStore / SqliteFactStore constructors marked @internal —
intended only for SqliteStorage to use internally.

This completes the #215 FactStore + Storage port refactor. Postgres
adapter (#216-218) can now ship by implementing Storage against
pg + pgvector and running the same contract test suite.

Plan: docs/plans/2026-05-30-factstore-storage-port.md (Task 6)"
```

---

## Task 7: Verification + Code Review + Wrap-Up

**Goal:** Pre-merge verification. Update CHANGELOG. Surface the PR description for review.

- [ ] **Step 1: Verify zero remaining call sites of removed/internal APIs**

Run these three:

```bash
grep -rn "insertManyInTxn" src/ tests/   # expect: zero
grep -rn "new SqliteSessionStore" src/ tests/  # expect: only in src/core/storage/sqlite-storage.ts
grep -rn "new SqliteFactStore" src/ tests/     # expect: only in src/core/storage/sqlite-storage.ts
```

Any unexpected match: stop and migrate before continuing.

- [ ] **Step 2: Verify rawDb() usage is bounded**

Run: `grep -rn "\.rawDb()" src/ tests/ | wc -l`
Expected: Roughly the same count as the baseline (we did not introduce new uses; we just routed them through `storage.rawDb()` instead of `store.rawDb()`). The number is the explicit #215a backlog.

- [ ] **Step 3: Dispatch code-review skill on the branch diff**

Invoke `code-review:code-review` against the diff between `feat/factstore-port-storage` and `main`. Specifically ask it to verify:

1. The contract test in `tests/contract/fact-store.contract.ts` actually covers every behavior in the pre-refactor `tests/integration/sqlite-fact-store.test.ts` (no silent assertion drops).
2. The inlined ingest logic in `SqliteSessionStore` and the port-level `SqliteFactStore.ingestSessionFacts` are equivalent — same DELETE, same insert order, same supersedence semantics.
3. No `await` was forgotten on the now-async `upsertEmbedding`.
4. `withTransaction` properly rolls back on thrown errors (add a contract assertion if missing).

- [ ] **Step 4: Address review findings**

Each finding gets a new commit on the branch. Do not amend earlier commits — the linear history is the safety argument for this refactor.

- [ ] **Step 5: Update sub-project CHANGELOG**

Append to `logs/CHANGELOG/CHANGELOG.md`:

```markdown
## 2026-05-30 — FactStore + Storage port refactor (#215)

### Changes
- Added `Storage` port (`src/ports/storage.ts`) with `withTransaction`, `init`, `close`.
- Added `upsertEmbedding` and `ingestSessionFacts` to `FactStore` port.
- New `SqliteStorage` class — canonical construction path for all callers.
- Removed `SqliteFactStore.insertManyInTxn`; replaced by inlined ingest in SqliteSessionStore + port-level `ingestSessionFacts` for backend-agnostic callers.
- Extracted contract test (`tests/contract/fact-store.contract.ts`) — same assertions will run against the Postgres adapter (#216-218).

### Decisions
- `withTransaction` callbacks must be sync (better-sqlite3 constraint); embedding work stays outside the txn, mirroring original `insertSession` pattern.
- `rawDb()` preserved as deprecated escape hatch for the 5 known port-leak callers (scheduler, http actions, backfill-facts, source/provider registries). Tracked as #215a.
- Pure repository pattern (Option A) chosen over wrapper pattern (Option B) — avoids construction-path drift.

### State
- 8 production callers migrated; ~30 test files migrated.
- Old `new SqliteSessionStore` / `new SqliteFactStore` constructors marked `@internal`.
- All tests green; contract suite proves FactStore behavior is backend-portable.

### Next
- #215a — Audit non-FactStore port leaks (scheduler, actions, sources, providers, backfill).
- #216 — Implement `PostgresStorage` against pg + pgvector; run contract suite.
- #217-218 — Teams multi-tenancy layered on the port.
```

- [ ] **Step 6: Surface PR for Edward's review**

Do NOT push or create the PR autonomously. Surface the PR title + body draft inline so Edward can review:

**Title:** `feat: FactStore + Storage port refactor (#215)`

**Body draft:**
```
## Summary
- Introduces Storage port (withTransaction primitive) + SqliteStorage adapter
- Lifts upsertEmbedding + ingestSessionFacts onto the FactStore port
- Removes SqliteFactStore.insertManyInTxn (replaced by inlined sync ingest in SqliteSessionStore + async ingestSessionFacts port method for backend-agnostic callers)
- Extracts a backend-agnostic contract test (tests/contract/fact-store.contract.ts) — the only proof the upcoming Postgres adapter is behaviorally equivalent
- Migrates 8 production + ~30 test construction sites to a single canonical path (SqliteStorage.create)

## Why
Unblocks #216-218 (NLM Teams Postgres adapter). The contract test is the load-bearing artifact: when the PG adapter lands, the same assertions run unchanged against both backends.

## Out of scope (tracked as #215a)
Five callers still use storage.rawDb() as a typed, deprecated escape hatch: scheduler, http actions endpoints, backfill-facts, source/provider registries. Each is marked with TODO(#215a). Removing them is a separate refactor.

## Test plan
- [ ] Full test suite green (same baseline + 4 new ingestSessionFacts assertions)
- [ ] Contract test (tests/contract/fact-store.contract.ts) covers all pre-refactor behaviors
- [ ] grep "insertManyInTxn" → zero matches in src/ and tests/
- [ ] grep "new SqliteSessionStore" → only matches inside src/core/storage/sqlite-storage.ts
- [ ] Manual: cli/nlm.ts smoke test against a temp DB
- [ ] Manual: install/setup.sh runs cleanly end-to-end
```

- [ ] **Step 7: Hand off to Edward**

Report completion to Edward with: branch name, commit count, file change count, test count delta, link to plan file. Wait for Edward's go-ahead before pushing or merging.

---

## Rollback Procedure

If any task introduces a regression that is not caught until later:

- Each task is exactly one commit. `git revert <sha>` of the offending task is the rollback.
- Tasks 2 and 3 are safely revertable in isolation. Task 4 must be reverted along with Tasks 5 and 6 (the ingest logic move propagates through caller migrations).
- If Task 4 needs to be redesigned: revert Tasks 4-6, keep Tasks 1-3 (port + harness + SqliteStorage stay landed as additive — they don't change behavior on their own).

## Notes for the Executing Engineer

1. **Do not change the embedding model assumptions.** `nomic-embed-text` → 768 dims is part of the public protocol. The port does not name it, but the fact_embeddings schema enforces it.
2. **`withTransaction` callbacks must be synchronous.** If you find yourself wanting to `await` an embedder call inside a `withTransaction` body, put the embedder call AFTER the `withTransaction` block (mirroring the original `insertSession` pattern at sqlite-session-store.ts:~300).
3. **The contract test is the spec.** If during the PG adapter work (#216) you find an assertion that "feels" SQLite-specific (e.g. asserts a SQLite-only error message), that's a contract bug — fix the assertion to be about behavior, not implementation.
4. **Sub-project session protocol.** When ending a session mid-plan, follow `.claude/rules/session-protocols.md` — tick completed checkboxes, stamp a Resume status block, surface a copy-pasteable resume prompt.
