/**
 * HTTP adapter integration. Exercises the Hono app via app.request() against
 * a real SqliteSessionStore + RecallService. No network, no port binding.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { FactRecallService } from "../../src/core/recall-facts/fact-recall-service.js";
import { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { createApp } from "../../src/http/app.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { Session } from "../../src/shared/types.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function unit(values: number[]): Float32Array {
  const padded = new Float32Array(768);
  values.forEach((v, i) => {
    padded[i] = v;
  });
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
      summary: "Wired Hono routes to RecallService",
      entities: ["NLE Memory"],
      decisions: ["chose Hono"],
    }),
    embedding: unit([1, 0, 0]),
  },
  {
    session: makeSession({
      id: "sess_b",
      label: "pgvector migration plan",
      entities: ["NLE Memory", "Postgres"],
      open: ["cutover timing"],
    }),
    embedding: unit([0, 1, 0]),
  },
];

describe("HTTP adapter", () => {
  let tmp: string;
  let store: SqliteSessionStore;
  let app: Hono;
  let queryLogPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nle-http-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    for (const { session, embedding } of seed) {
      store.insertSessionForTest(session);
      store.insertEmbeddingForTest(session.id, embedding);
    }
    const recall = new RecallService({
      store,
      llm: new FixedEmbedder(unit([0, 1, 0])),
    });
    queryLogPath = join(tmp, "query_log.jsonl");
    app = createApp({ recall, store, liveStore: store, queryLogPath });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("GET /api/health returns ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("GET /api/recall?q=pgvector returns the matching session", async () => {
    const res = await app.request("/api/recall?q=pgvector&mode=keyword");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; results: { id: string }[] };
    expect(body.total).toBe(1);
    expect(body.results[0]?.id).toBe("sess_b");
  });

  it("GET /api/recall rejects invalid mode", async () => {
    const res = await app.request("/api/recall?q=x&mode=banana");
    expect(res.status).toBe(400);
  });

  it("GET /api/recall rejects out-of-range limit", async () => {
    const res = await app.request("/api/recall?q=x&limit=9999");
    expect(res.status).toBe(400);
  });

  it("GET /api/recall threads entity filter through to RecallService", async () => {
    const res = await app.request("/api/recall?q=hono&entity=NLE%20Memory&mode=keyword");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entity: string | null;
      results: { entities: string[] }[];
    };
    expect(body.entity).toBe("NLE Memory");
    expect(body.results.every((r) => r.entities.includes("NLE Memory"))).toBe(true);
  });

  it("GET /api/recall semantic mode goes through the embedder + vec0", async () => {
    const res = await app.request("/api/recall?q=anything&mode=semantic&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { id: string; matchScore: number }[] };
    expect(body.results[0]?.id).toBe("sess_b"); // embedder aligned with [0,1,0]
    expect(body.results[0]?.matchScore).toBeCloseTo(1, 4);
  });

  it("GET /api/session/:id returns the full session", async () => {
    const res = await app.request("/api/session/sess_a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; entities: string[] };
    expect(body.id).toBe("sess_a");
    expect(body.entities).toContain("NLE Memory");
  });

  it("GET /api/session/:id 404s on unknown id", async () => {
    const res = await app.request("/api/session/does_not_exist");
    expect(res.status).toBe(404);
  });

  it("GET /api/recall/stats returns zero-totals when log is absent", async () => {
    const res = await app.request("/api/recall/stats?days=14");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: number;
      total: number;
      log_present: boolean;
    };
    expect(body.days).toBe(14);
    expect(body.total).toBe(0);
    expect(body.log_present).toBe(false);
  });

  it("GET /api/recall writes a query-log entry; /api/recall/stats aggregates it", async () => {
    // Drive two recall calls
    await app.request("/api/recall?q=pgvector&mode=keyword", {
      headers: { "x-recall-source": "test-source" },
    });
    await app.request("/api/recall?q=hono&mode=keyword");
    // logQuery is fire-and-forget; small await so the appendFile lands
    await new Promise((r) => setTimeout(r, 50));

    const res = await app.request("/api/recall/stats?days=7");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      with_results: number;
      hit_rate: number;
      by_source: Record<string, number>;
      log_present: boolean;
    };
    expect(body.log_present).toBe(true);
    expect(body.total).toBe(2);
    expect(body.with_results).toBeGreaterThanOrEqual(1);
    expect(body.by_source["test-source"]).toBe(1);
    expect(body.by_source["http"]).toBe(1);
  });

  it("GET /api/live/recent-writes returns persisted sessions ordered by recency", async () => {
    const res = await app.request("/api/live/recent-writes?limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { writes: { id: string; label: string }[] };
    expect(body.writes.length).toBeGreaterThanOrEqual(2);
    expect(body.writes.map((w) => w.id)).toEqual(
      expect.arrayContaining(["sess_a", "sess_b"]),
    );
  });

  it("GET /api/live/recent-markers returns decision + open markers", async () => {
    const res = await app.request("/api/live/recent-markers?limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      markers: { kind: string; text: string; sessionId: string }[];
    };
    expect(body.markers.length).toBeGreaterThanOrEqual(2);
    expect(body.markers.some((m) => m.kind === "decision")).toBe(true);
    expect(body.markers.some((m) => m.kind === "open")).toBe(true);
  });

  it("GET /api/recall/recent returns tailed log entries", async () => {
    await app.request("/api/recall?q=pgvector&mode=keyword");
    await new Promise((r) => setTimeout(r, 50));
    const res = await app.request("/api/recall/recent?limit=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { source: string; query: string }[] };
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.entries[0]?.query).toBe("pgvector");
  });
});

describe("HTTP adapter — data management", () => {
  let tmp: string;
  let dbPath: string;
  let store: SqliteSessionStore;
  let app: Hono;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nle-http-data-"));
    dbPath = join(tmp, "canonical.sqlite");
    store = new SqliteSessionStore({ dbPath, migrationsDir: MIGRATIONS_DIR });
    for (const { session, embedding } of seed) {
      store.insertSessionForTest(session);
      store.insertEmbeddingForTest(session.id, embedding);
    }
    const recall = new RecallService({ store, llm: new FixedEmbedder(unit([0, 1, 0])) });
    app = createApp({ recall, store, liveStore: store, dbPath });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("GET /api/data/stats reports table counts, runtimes, and schema version", async () => {
    const res = await app.request("/api/data/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dbPath: string;
      dbBytes: number;
      schemaVersion: number;
      tables: { name: string; rows: number }[];
      runtimes: { runtime: string; n: number }[];
    };
    expect(body.dbPath).toBe(dbPath);
    expect(body.dbBytes).toBeGreaterThan(0);
    expect(body.schemaVersion).toBeGreaterThanOrEqual(0);
    expect(body.tables.find((t) => t.name === "sessions")?.rows).toBe(2);
    expect(body.runtimes.reduce((sum, r) => sum + r.n, 0)).toBe(2);
  });

  it("GET /api/data/stats 503s without dbPath", async () => {
    const recall = new RecallService({ store, llm: new FixedEmbedder(unit([0, 1, 0])) });
    const noPath = createApp({ recall, store, liveStore: store });
    const res = await noPath.request("/api/data/stats");
    expect(res.status).toBe(503);
  });

  it("GET /api/data/backup streams a restorable SQLite snapshot", async () => {
    const res = await app.request("/api/data/backup");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/nle-memory-backup-.*\.sqlite/);
    const bytes = Buffer.from(await res.arrayBuffer());
    // SQLite files start with the "SQLite format 3\0" magic header.
    expect(bytes.subarray(0, 15).toString("latin1")).toBe("SQLite format 3");
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("POST /api/data/restore stages a valid backup and reports restartRequired", async () => {
    const backup = Buffer.from(await (await app.request("/api/data/backup")).arrayBuffer());
    const fd = new FormData();
    fd.append("file", new Blob([backup]), "backup.sqlite");
    const res = await app.request("/api/data/restore", { method: "POST", body: fd });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { staged: boolean; restartRequired: boolean; sessions: number };
    expect(body.staged).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(body.sessions).toBe(2);
  });

  it("POST /api/data/restore rejects a non-SQLite upload", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["not a database"]), "junk.sqlite");
    const res = await app.request("/api/data/restore", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/rejected/);
  });

  it("POST /api/data/restore 400s when no file field is present", async () => {
    const res = await app.request("/api/data/restore", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
  });
});

describe("HTTP adapter — fact recall", () => {
  let tmp: string;
  let store: SqliteSessionStore;
  let factStore: SqliteFactStore;
  let app: Hono;
  let factQueryLogPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nle-http-facts-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    store.insertSessionForTest(makeSession({ id: "sess_p" }));
    factStore = new SqliteFactStore(store.rawDb());
    await factStore.insertMany([
      makeFact({
        id: "f_hono", subject: "nle-memory-ts", predicate: "framework",
        value: "Hono", confidence: 0.9, sourceSessionId: "sess_p",
      }),
      makeFact({
        id: "f_fastify", subject: "nle-memory-ts", predicate: "framework",
        value: "Fastify", confidence: 0.9, sourceSessionId: "sess_p",
        createdAt: "2026-05-01T00:00:00Z", supersededBy: "f_hono",
      }),
    ]);
    const recall = new RecallService({ store, llm: new FixedEmbedder(unit([1, 0, 0])) });
    const factRecall = new FactRecallService({
      factStore,
      llm: new FixedEmbedder(unit([1, 0, 0])),
    });
    factQueryLogPath = join(tmp, "fact_query_log.jsonl");
    app = createApp({ recall, store, factRecall, factStore, factQueryLogPath });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("GET /api/recall/facts returns the current fact for subject+predicate", async () => {
    const res = await app.request("/api/recall/facts?subject=nle-memory-ts&predicate=framework");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; results: { id: string; value: string }[] };
    expect(body.total).toBe(1);
    expect(body.results[0]?.id).toBe("f_hono");
    expect(body.results[0]?.value).toBe("Hono");
  });

  it("GET /api/recall/facts excludes superseded by default, includes with flag", async () => {
    const def = await app.request("/api/recall/facts?subject=nle-memory-ts");
    expect(((await def.json()) as { total: number }).total).toBe(1);
    const all = await app.request("/api/recall/facts?subject=nle-memory-ts&includeSuperseded=true");
    expect(((await all.json()) as { total: number }).total).toBe(2);
  });

  it("GET /api/recall/facts rejects invalid kind + mode", async () => {
    expect((await app.request("/api/recall/facts?kind=banana")).status).toBe(400);
    expect((await app.request("/api/recall/facts?subject=x&mode=banana")).status).toBe(400);
  });

  it("GET /api/facts/history walks the supersedence chain", async () => {
    const res = await app.request("/api/facts/history?subject=nle-memory-ts&predicate=framework");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chains: { history: { id: string }[] }[] };
    expect(body.chains[0]?.history.map((f) => f.id)).toEqual(["f_hono", "f_fastify"]);
  });

  it("GET /api/facts/history 400s without a subject", async () => {
    expect((await app.request("/api/facts/history")).status).toBe(400);
  });

  it("GET /api/recall/facts records a fact query-log entry", async () => {
    await app.request("/api/recall/facts?subject=nle-memory-ts&predicate=framework");
    // logFactQuery is fire-and-forget; give the microtask a tick.
    await new Promise((r) => setTimeout(r, 50));
    const stats = await app.request("/api/recall/facts/stats?days=7");
    const body = (await stats.json()) as {
      total: number;
      hit_rate: number;
      log_present: boolean;
    };
    expect(body.log_present).toBe(true);
    expect(body.total).toBe(1);
    expect(body.hit_rate).toBe(1);
  });

  it("GET /api/recall/facts 503s when factRecall is not wired", async () => {
    const bare = createApp({
      recall: new RecallService({ store, llm: new FixedEmbedder(unit([1, 0, 0])) }),
      store,
    });
    expect((await bare.request("/api/recall/facts?subject=x")).status).toBe(503);
  });
});
