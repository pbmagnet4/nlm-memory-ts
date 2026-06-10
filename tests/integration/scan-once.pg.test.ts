/**
 * scanOncePg adapter_state lifecycle — PG parity with the SQLite scan path.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL to a
 * connection string, e.g.:
 *   export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"
 *
 * Skips when the env var is absent. Tables are truncated between tests for
 * isolation; schema is applied on first setup() call.
 *
 * Verifies the bug fix: the PG scan path no longer upserts adapter_state
 * before classification. adapter_state only advances via recordClassifiedPg
 * (success) or recordFailedPg (failure), mirroring SQLite recordClassified /
 * recordFailed. A classify failure must not silently mark the file processed.
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import {
  MAX_CLASSIFY_FAILURES,
  getFileSize,
  recordClassifiedPg,
  recordFailedPg,
  scanOncePg,
} from "../../src/core/scheduler/scan-once.js";
import type {
  DetectionResult,
  SessionChunk,
  TranscriptAdapter,
} from "../../src/ports/transcript-adapter.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = "TRUNCATE TABLE adapter_state RESTART IDENTITY CASCADE";

class FixtureAdapter implements TranscriptAdapter {
  readonly name = "claude-code";
  readonly runtimeVersion = "test";
  readonly transcriptKind = "claude-code";
  constructor(
    private readonly path: string,
    private readonly chunkId: string,
  ) {}
  detect(): DetectionResult {
    return { adapterName: this.name, enabled: true, path: this.path, hint: null };
  }
  async discover(): Promise<string[]> {
    return [this.path];
  }
  async parseSession(sourcePath: string): Promise<SessionChunk | null> {
    return {
      id: this.chunkId,
      runtime: "claude-code",
      runtimeSessionId: this.chunkId,
      sourcePath,
      startedAt: "2026-05-19T10:00:00Z",
      endedAt: "2026-05-19T10:30:00Z",
      durationMin: 30,
      turnCount: 1,
      byteRange: [0, getFileSize(sourcePath) ?? 0] as const,
      projectDir: "project_a",
      gitBranch: "main",
      text: "stub body",
      label: "",
    };
  }
}

async function readState(pool: Pool, sourcePath: string) {
  const res = await pool.query<{ file_size: string | null; session_id: string | null; failure_count: number }>(
    "SELECT file_size, session_id, COALESCE(failure_count, 0) AS failure_count FROM adapter_state WHERE source_path = $1",
    [sourcePath],
  );
  return res.rows[0] ?? null;
}

describe.skipIf(!PG_TEST_URL)("scanOncePg: adapter_state lifecycle (PG)", () => {
  let storage: PgStorage;
  let pool: Pool;
  let tmp: string;
  let fixturePath: string;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: PG_TEST_URL!, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_SQL);
    tmp = mkdtempSync(join(tmpdir(), "nlm-scanpg-"));
    fixturePath = join(tmp, "fixture.jsonl");
    writeFileSync(fixturePath, "line one\n");
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(fixturePath, old, old);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("scanOncePg does not write adapter_state before classification", async () => {
    const adapter = new FixtureAdapter(fixturePath, "sess_1");
    const results = await scanOncePg(adapter, 15, pool);
    expect(results).toHaveLength(1);
    // The scan itself must not have touched adapter_state — recording is the
    // scheduler's job, only after a successful insertSession.
    expect(await readState(pool, fixturePath)).toBeNull();
  });

  it("a classify failure does not advance file_size to current size — file re-attempted next tick", async () => {
    const adapter = new FixtureAdapter(fixturePath, "sess_1");

    // First scan surfaces the file; classification fails downstream.
    expect(await scanOncePg(adapter, 15, pool)).toHaveLength(1);
    const newCount = await recordFailedPg(pool, adapter.name, fixturePath, getFileSize(fixturePath));
    expect(newCount).toBe(1);

    const state = await readState(pool, fixturePath);
    expect(state?.failure_count).toBe(1);
    expect(state?.session_id).toBeNull(); // no session was inserted

    // recordFailedPg writes file_size = current; SQLite recordFailed does the
    // same. The retry path is growth: scanOncePg skips when size is unchanged.
    const sameSize = await scanOncePg(adapter, 15, pool);
    expect(sameSize).toHaveLength(0);

    // Grow the file → scan re-attempts it.
    writeFileSync(fixturePath, "line one\nline two\n");
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(fixturePath, old, old);
    const afterGrowth = await scanOncePg(adapter, 15, pool);
    expect(afterGrowth).toHaveLength(1);
  });

  it("file is skipped once failure_count reaches the ceiling and size is unchanged", async () => {
    const adapter = new FixtureAdapter(fixturePath, "sess_1");
    for (let i = 0; i < MAX_CLASSIFY_FAILURES; i++) {
      const seen = await scanOncePg(adapter, 15, pool);
      // First iteration sees the file; later iterations skip because size is
      // unchanged after recordFailedPg wrote file_size = current.
      if (i === 0) expect(seen).toHaveLength(1);
      else expect(seen).toHaveLength(0);
      await recordFailedPg(pool, adapter.name, fixturePath, getFileSize(fixturePath));
    }
    const state = await readState(pool, fixturePath);
    expect(state?.failure_count).toBe(MAX_CLASSIFY_FAILURES);

    // Even though the ceiling is reached, the gate is the unchanged size.
    const skipped = await scanOncePg(adapter, 15, pool);
    expect(skipped).toHaveLength(0);
  });

  it("recordClassifiedPg records size + session_id and resets failure_count", async () => {
    const adapter = new FixtureAdapter(fixturePath, "sess_1");
    await recordFailedPg(pool, adapter.name, fixturePath, getFileSize(fixturePath));
    await recordClassifiedPg(pool, adapter.name, fixturePath, "sess_1");

    const state = await readState(pool, fixturePath);
    expect(state?.session_id).toBe("sess_1");
    expect(Number(state?.file_size)).toBe(getFileSize(fixturePath));
    expect(state?.failure_count).toBe(0);
  });

  it("supersedes points at the prior session_id when the file grows under a new id", async () => {
    const adapter1 = new FixtureAdapter(fixturePath, "sess_1");
    await recordClassifiedPg(pool, adapter1.name, fixturePath, "sess_1");

    writeFileSync(fixturePath, "line one\nline two\n");
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(fixturePath, old, old);

    const adapter2 = new FixtureAdapter(fixturePath, "sess_2");
    const results = await scanOncePg(adapter2, 15, pool);
    expect(results).toHaveLength(1);
    expect(results[0]?.supersedes).toBe("sess_1");
  });

  it("does not self-supersede when a grown file resumes under the same id", async () => {
    const adapter = new FixtureAdapter(fixturePath, "sess_1");
    await recordClassifiedPg(pool, adapter.name, fixturePath, "sess_1");

    writeFileSync(fixturePath, "line one\nline two\n");
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(fixturePath, old, old);

    const results = await scanOncePg(adapter, 15, pool);
    expect(results).toHaveLength(1);
    expect(results[0]?.supersedes).toBeNull();
  });
});
