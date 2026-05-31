/**
 * End-to-end integration: RecallService → SqliteSessionStore → real SQLite
 * with sqlite-vec loaded. Spins up a tmp DB, runs migrations, seeds a small
 * corpus including embeddings, and exercises keyword + semantic recall.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { Session } from "../../src/shared/types.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function unit(values: number[]): Float32Array {
  const padded = new Float32Array(768);
  values.forEach((v, i) => {
    padded[i] = v;
  });
  // normalize to unit length (session_embeddings expects unit vectors)
  let sum = 0;
  for (const v of padded) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < padded.length; i++) padded[i] = (padded[i] ?? 0) / norm;
  return padded;
}

class FixedEmbedder implements LLMClient {
  constructor(private readonly vector: Float32Array) {}
  async embed(): Promise<EmbedResult> {
    return { vector: this.vector, model: "fixed-test" };
  }
  async classify(): Promise<never> {
    throw new Error("not used in this test");
  }
}

const seed: ReadonlyArray<{ session: Session; embedding: Float32Array }> = [
  {
    session: makeSession({
      id: "sess_a",
      label: "Hono router setup",
      summary: "Wired Hono onto port 3940 with sqlite session store",
      body: "Chose Hono over Express for routing. Mounted the recall API on port 3940.",
      entities: ["NLM"],
      decisions: ["chose Hono over Express for routing"],
    }),
    embedding: unit([1, 0, 0]),
  },
  {
    session: makeSession({
      id: "sess_b",
      label: "pgvector migration plan",
      summary: "Sketched eventual Postgres mirror via PostgresSessionStore port",
      body: "Planned the pgvector power tier. Open question: timing of cutover from SQLite to Postgres.",
      entities: ["NLM", "Postgres"],
      open: ["timing of cutover from SQLite to Postgres"],
    }),
    embedding: unit([0, 1, 0]),
  },
  {
    session: makeSession({
      id: "sess_c",
      label: "TX Tax county scraper",
      summary: "Unrelated work on Texas tax exemption directory",
      body: "Built the Texas tax exemption county scraper and directory pipeline.",
      entities: ["TX Tax Exemptions"],
    }),
    embedding: unit([0, 0, 1]),
  },
];

describe("RecallService against SqliteSessionStore (integration)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteStorage["sessions"];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-mem-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
    for (const { session, embedding } of seed) {
      store.insertSessionForTest(session);
      store.insertEmbeddingForTest(session.id, embedding);
    }
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads sessions with their entities and markers via list()", async () => {
    const all = await store.list();
    expect(all).toHaveLength(3);
    const b = all.find((s) => s.id === "sess_b");
    expect(b?.entities).toEqual(["NLM", "Postgres"]);
    expect(b?.open).toEqual(["timing of cutover from SQLite to Postgres"]);
  });

  it("keyword recall finds the right session through the full pipeline", async () => {
    const svc = new RecallService({
      store,
      llm: new FixedEmbedder(unit([1, 0, 0])),
    });
    const result = await svc.search({ query: "pgvector", mode: "keyword" });
    expect(result.total).toBe(1);
    expect(result.results[0]?.id).toBe("sess_b");
    expect(result.results[0]?.matchedIn).toContain("label");
  });

  it("semantic recall returns the nearest neighbor via sqlite-vec KNN", async () => {
    // query vector aligned with sess_a's embedding → distance 0, cosine 1
    const svc = new RecallService({
      store,
      llm: new FixedEmbedder(unit([1, 0, 0])),
    });
    const result = await svc.search({
      query: "anything",
      mode: "semantic",
      limit: 3,
    });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.id).toBe("sess_a");
    expect(result.results[0]?.matchScore).toBeCloseTo(1, 4);
  });

  it("hybrid recall blends keyword + semantic against the real store", async () => {
    const svc = new RecallService({
      store,
      llm: new FixedEmbedder(unit([0, 1, 0])), // aligned with sess_b
    });
    const result = await svc.search({ query: "pgvector", mode: "hybrid" });
    const top = result.results[0];
    expect(top?.id).toBe("sess_b");
    expect(top?.keywordScore).toBe(1);
    expect(top?.semanticScore).toBeCloseTo(1, 4);
  });

  it("entity filter restricts recall results", async () => {
    const svc = new RecallService({
      store,
      llm: new FixedEmbedder(unit([1, 0, 0])),
    });
    const result = await svc.search({
      query: "scraper",
      mode: "keyword",
      entity: "NLM",
    });
    expect(result.results).toHaveLength(0);
  });

  it("migration runner is idempotent on a second open", async () => {
    await storage.close();
    // Reopening with the same dbPath should not throw — migrations already applied
    const reopened = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await reopened.init();
    const all = await reopened.sessions.list();
    expect(all).toHaveLength(3);
    await reopened.close();
  });
});
