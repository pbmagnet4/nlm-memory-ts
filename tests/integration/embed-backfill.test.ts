/**
 * Integration tests for embed-backfill + embed-normalize against a real
 * SQLite + sqlite-vec store. No network: a deterministic fake LLMClient
 * stands in for Ollama.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { reembedCorpus } from "../../src/core/embedding/embed-backfill.js";
import { normalizeEmbeddings } from "../../src/core/embedding/embed-normalize.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { Session } from "../../src/shared/types.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function unitWithLeading(value: number): Float32Array {
  const v = new Float32Array(768);
  v[0] = value;
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += (v[i] ?? 0) ** 2;
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(768);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / n;
  return out;
}

class DeterministicEmbedder implements LLMClient {
  calls = 0;
  async embed(): Promise<EmbedResult> {
    this.calls += 1;
    // Stable, distinct, unit-length vectors per call
    return { vector: unitWithLeading(this.calls), model: "fake" };
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

const seed: ReadonlyArray<Session> = [
  makeSession({ id: "s_a", label: "Hono setup", body: "wired Hono routes" }),
  makeSession({ id: "s_b", label: "pgvector plan", body: "drafted pgvector swap" }),
  makeSession({ id: "s_c", label: "tx tax county", body: "ingested county directory" }),
];

describe("reembedCorpus", () => {
  let tmp: string;
  let dbPath: string;
  let statePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-emb-"));
    dbPath = join(tmp, "canonical.sqlite");
    statePath = join(tmp, "state.json");
    const store = new SqliteSessionStore({ dbPath, migrationsDir: MIGRATIONS_DIR });
    for (const s of seed) {
      store.insertSessionForTest(s);
      // seed each with a non-normalized vector so backfill has something to replace
      store.insertEmbeddingForTest(s.id, new Float32Array(768).fill(0.5));
    }
    store.close();
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("replaces every embedding and writes a state file", async () => {
    const embedder = new DeterministicEmbedder();
    const report = await reembedCorpus({ dbPath, embedder, statePath });
    expect(report.dbMissing).toBe(false);
    expect(report.total).toBe(3);
    expect(report.succeeded).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.skippedAlreadyDone).toBe(0);
    expect(embedder.calls).toBe(3);
    expect(existsSync(statePath)).toBe(true);
  });

  it("is resumable — second run skips ids already in state", async () => {
    const embedder1 = new DeterministicEmbedder();
    await reembedCorpus({ dbPath, embedder: embedder1, statePath });
    const embedder2 = new DeterministicEmbedder();
    const report = await reembedCorpus({ dbPath, embedder: embedder2, statePath });
    expect(report.skippedAlreadyDone).toBe(3);
    expect(report.succeeded).toBe(0);
    expect(embedder2.calls).toBe(0);
  });

  it("respects --limit", async () => {
    const embedder = new DeterministicEmbedder();
    const report = await reembedCorpus({ dbPath, embedder, statePath, limit: 2 });
    expect(report.total).toBe(2);
    expect(report.succeeded).toBe(2);
  });
});

describe("normalizeEmbeddings", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-norm-"));
    dbPath = join(tmp, "canonical.sqlite");
    const store = new SqliteSessionStore({ dbPath, migrationsDir: MIGRATIONS_DIR });
    store.insertSessionForTest(makeSession({ id: "raw" }));
    store.insertSessionForTest(makeSession({ id: "already" }));
    store.insertSessionForTest(makeSession({ id: "zero" }));
    store.close();
    // embed-normalize operates on the legacy session_embeddings table that
    // migration 003 still creates (left in place for rollback safety after
    // the chunk + max-pool migration). Seed it directly via raw SQL — the
    // session store's helpers now target session_embedding_chunks.
    const db = new Database(dbPath);
    sqliteVec.load(db);
    const ins = db.prepare(
      "INSERT INTO session_embeddings (session_id, embedding) VALUES (?, ?)",
    );
    const toBlob = (v: Float32Array): Buffer =>
      Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    // raw: non-unit (||v|| = sqrt(768 * 0.25) ≈ 13.86)
    ins.run("raw", toBlob(new Float32Array(768).fill(0.5)));
    // already: unit (one component at 1.0)
    const unit = new Float32Array(768);
    unit[0] = 1;
    ins.run("already", toBlob(unit));
    // zero: zero vector
    ins.run("zero", toBlob(new Float32Array(768)));
    db.close();
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("rewrites only the non-unit non-zero row", () => {
    const report = normalizeEmbeddings({ dbPath });
    expect(report.total).toBe(3);
    expect(report.rewritten).toBe(1);
    expect(report.alreadyNormalized).toBe(1);
    expect(report.zeroVector).toBe(1);
  });

  it("dry-run reports the same counts without writing", () => {
    const beforeDb = new Database(dbPath);
    sqliteVec.load(beforeDb);
    const beforeBlob = beforeDb
      .prepare<[string], { embedding: Buffer }>(
        "SELECT embedding FROM session_embeddings WHERE session_id = ?",
      )
      .get("raw")!.embedding;
    beforeDb.close();

    const report = normalizeEmbeddings({ dbPath, dryRun: true });
    expect(report.rewritten).toBe(1);
    expect(report.dryRun).toBe(true);

    const afterDb = new Database(dbPath);
    sqliteVec.load(afterDb);
    const afterBlob = afterDb
      .prepare<[string], { embedding: Buffer }>(
        "SELECT embedding FROM session_embeddings WHERE session_id = ?",
      )
      .get("raw")!.embedding;
    afterDb.close();
    expect(afterBlob.equals(beforeBlob)).toBe(true);
  });

  it("is idempotent — second run rewrites nothing", () => {
    normalizeEmbeddings({ dbPath });
    const report = normalizeEmbeddings({ dbPath });
    expect(report.rewritten).toBe(0);
    expect(report.alreadyNormalized).toBe(2); // raw is now unit too
  });
});
