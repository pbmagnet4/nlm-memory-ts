/**
 * Cycle guard for markSuperseded across both backends. Edges read
 * (from, to) = "from supersedes to"; markSuperseded(predecessor, successor)
 * inserts (successor, predecessor). A cycle would close when the predecessor
 * can already reach the successor by following supersedes edges. The guard
 * walks from→to from the predecessor and rejects before writing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import type { Session } from "../../src/shared/types.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { PgStorage } from "../../src/core/storage/pg-storage.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];

function makeSession(id: string): Session {
  return {
    id,
    runtime: "claude-code",
    runtimeSessionId: id,
    startedAt: "2026-05-19T10:00:00Z",
    endedAt: "2026-05-19T10:30:00Z",
    durationMin: 30,
    label: id,
    summary: "",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    body: "",
    entities: [],
    decisions: [],
    open: [],
  };
}

type SeedableSessions = Storage["sessions"] & {
  insertSessionForTest(session: Session): Promise<void> | void;
};

interface Backend {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
}

let sqliteTmp = "";
const sqliteBackend: Backend = {
  name: "SqliteSessionStore",
  async setup() {
    sqliteTmp = mkdtempSync(join(tmpdir(), "nlm-cycle-"));
    const storage = SqliteStorage.create({
      dbPath: join(sqliteTmp, "canonical.sqlite"),
      migrationsDir: resolve(__dirname, "../../migrations"),
    });
    await storage.init();
    return storage;
  },
  async teardown(storage) {
    await storage.close();
    rmSync(sqliteTmp, { recursive: true, force: true });
  },
};

const pgBackend: Backend = {
  name: "PgSessionStore",
  async setup() {
    const storage = PgStorage.create({
      connectionString: PG_TEST_URL!,
      migrationsDir: join(
        fileURLToPath(new URL(".", import.meta.url)),
        "../../migrations/pg",
      ),
    });
    await storage.init();
    await storage.pgPool().query(
      `TRUNCATE TABLE session_edges, sessions RESTART IDENTITY CASCADE`,
    );
    return storage;
  },
  async teardown(storage) {
    await storage.close();
  },
};

function runCycleContract(backend: Backend): void {
  describe(`${backend.name}: supersedence cycle guard`, () => {
    let storage: Storage;
    beforeEach(async () => {
      storage = await backend.setup();
    });
    afterEach(async () => {
      await backend.teardown(storage);
    });

    it("rejects a 2-node cycle (A supersedes B, then B supersedes A)", async () => {
      for (const id of ["A", "B"]) {
        await (storage.sessions as SeedableSessions).insertSessionForTest(makeSession(id));
      }
      // B supersedes A → edge (B, A).
      await storage.sessions.markSuperseded("A", "B");
      // A supersedes B would close the loop.
      await expect(storage.sessions.markSuperseded("B", "A")).rejects.toThrow(
        /supersedence cycle/,
      );
    });

    it("rejects a 3-node cycle (A->B->C chain, then C supersedes A)", async () => {
      for (const id of ["A", "B", "C"]) {
        await (storage.sessions as SeedableSessions).insertSessionForTest(makeSession(id));
      }
      // A supersedes B, B supersedes C.
      await storage.sessions.markSuperseded("B", "A");
      await storage.sessions.markSuperseded("C", "B");
      // C supersedes A would close A->B->C->A.
      await expect(storage.sessions.markSuperseded("A", "C")).rejects.toThrow(
        /supersedence cycle/,
      );
    });

    it("allows a legitimate depth-3 chain", async () => {
      for (const id of ["A", "B", "C", "D"]) {
        await (storage.sessions as SeedableSessions).insertSessionForTest(makeSession(id));
      }
      await storage.sessions.markSuperseded("B", "A");
      await storage.sessions.markSuperseded("C", "B");
      await expect(
        storage.sessions.markSuperseded("D", "C"),
      ).resolves.toBeUndefined();
    });

    it("rejects self-supersede", async () => {
      await (storage.sessions as SeedableSessions).insertSessionForTest(makeSession("A"));
      await expect(storage.sessions.markSuperseded("A", "A")).rejects.toThrow(
        /cannot supersede itself/,
      );
    });
  });
}

runCycleContract(sqliteBackend);
describe.skipIf(!PG_TEST_URL)("pg cycle guard", () => {
  runCycleContract(pgBackend);
});
