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
import type { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
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
  async rewriteForRecall(): Promise<never> {
    throw new Error("not used in tests");
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
      entities: ["NLM"],
      decisions: ["chose Hono"],
    }),
    embedding: unit([1, 0, 0]),
  },
  {
    session: makeSession({
      id: "sess_b",
      label: "pgvector migration plan",
      entities: ["NLM", "Postgres"],
      open: ["cutover timing"],
    }),
    embedding: unit([0, 1, 0]),
  },
];

describe("HTTP adapter", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  let app: Hono;
  let queryLogPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-http-"));
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
    const recall = new RecallService({
      store,
      llm: new FixedEmbedder(unit([0, 1, 0])),
    });
    queryLogPath = join(tmp, "query_log.jsonl");
    app = createApp({ recall, store, liveStore: store, queryLogPath });
  });

  afterEach(async () => {
    await storage.close();
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
    const res = await app.request("/api/recall?q=hono&entity=NLM&mode=keyword");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entity: string | null;
      results: { entities: string[] }[];
    };
    expect(body.entity).toBe("NLM");
    expect(body.results.every((r) => r.entities.includes("NLM"))).toBe(true);
  });

  it("GET /api/recall with x-recall-source: hook forces rewrite off (hot-path protection)", async () => {
    // Even if the caller passes ?rewrite=true, the hook source header
    // must force rewrite=false. The stub LLM here throws on rewrite, so a
    // forwarded rewrite would surface as an error. Success indicates the
    // server-side override fired.
    const res = await app.request("/api/recall?q=anything&mode=keyword&rewrite=true", {
      headers: { "x-recall-source": "hook" },
    });
    expect(res.status).toBe(200);
  });

  it("GET /api/recall semantic mode goes through the embedder + vec0", async () => {
    const res = await app.request("/api/recall?q=anything&mode=semantic&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { id: string; matchScore: number }[] };
    expect(body.results[0]?.id).toBe("sess_b"); // embedder aligned with [0,1,0]
    expect(body.results[0]?.matchScore).toBeCloseTo(1, 4);
  });

  it("GET /api/update-status returns a structured status payload", async () => {
    // Force opt-out so the endpoint doesn't hit the real npm registry from CI.
    process.env["NLM_DISABLE_UPDATE_CHECK"] = "1";
    try {
      const res = await app.request("/api/update-status");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        current: string;
        latest: string | null;
        behind: boolean;
        disabled?: string;
      };
      expect(typeof body.current).toBe("string");
      expect(body.behind).toBe(false);
      expect(body.disabled).toBe("user-opt-out");
    } finally {
      delete process.env["NLM_DISABLE_UPDATE_CHECK"];
    }
  });

  it("GET /api/session/:id returns the full session", async () => {
    const res = await app.request("/api/session/sess_a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; entities: string[] };
    expect(body.id).toBe("sess_a");
    expect(body.entities).toContain("NLM");
  });

  it("GET /api/session/:id 404s on unknown id", async () => {
    const res = await app.request("/api/session/does_not_exist");
    expect(res.status).toBe(404);
  });

  describe("POST /api/session/:id/supersede", () => {
    beforeEach(() => {
      process.env["NLM_SUPERSEDENCE_LOG"] = join(tmp, "supersedence-log.jsonl");
    });
    afterEach(() => {
      delete process.env["NLM_SUPERSEDENCE_LOG"];
    });

    it("marks the predecessor and links to the successor", async () => {
      const res = await app.request("/api/session/sess_a/supersede", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ successor_id: "sess_b", reason: "newer plan" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { marked: boolean; predecessor_id: string };
      expect(body.marked).toBe(true);
      expect(body.predecessor_id).toBe("sess_a");

      const after = await app.request("/api/session/sess_a");
      const ses = (await after.json()) as { status: string; supersededBy: string | null };
      expect(ses.status).toBe("superseded");
      expect(ses.supersededBy).toBe("sess_b");
    });

    it("400s when successor_id is missing", async () => {
      const res = await app.request("/api/session/sess_a/supersede", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("successor_id");
    });

    it("400s when request body is not JSON", async () => {
      const res = await app.request("/api/session/sess_a/supersede", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("400s when the predecessor is unknown", async () => {
      const res = await app.request("/api/session/ghost/supersede", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ successor_id: "sess_b" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("predecessor");
    });

    it("400s when predecessor equals successor", async () => {
      const res = await app.request("/api/session/sess_a/supersede", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ successor_id: "sess_a" }),
      });
      expect(res.status).toBe(400);
    });

    it("is idempotent — re-POST on the same pair stays clean", async () => {
      await app.request("/api/session/sess_a/supersede", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ successor_id: "sess_b" }),
      });
      const res = await app.request("/api/session/sess_a/supersede", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ successor_id: "sess_b" }),
      });
      expect(res.status).toBe(200);
      // sess_b should still report only one supersedes link
      const after = await app.request("/api/session/sess_b");
      const ses = (await after.json()) as { supersedes: string[] };
      expect(ses.supersedes).toEqual(["sess_a"]);
    });
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
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  let app: Hono;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-http-data-"));
    dbPath = join(tmp, "canonical.sqlite");
    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    store = storage.sessions;
    for (const { session, embedding } of seed) {
      store.insertSessionForTest(session);
      store.insertEmbeddingForTest(session.id, embedding);
    }
    const recall = new RecallService({ store, llm: new FixedEmbedder(unit([0, 1, 0])) });
    app = createApp({ recall, store, liveStore: store, dbPath });
  });

  afterEach(async () => {
    await storage.close();
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
    expect(res.headers.get("content-disposition")).toMatch(/nlm-memory-backup-.*\.sqlite/);
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
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  let factStore: SqliteFactStore;
  let app: Hono;
  let factQueryLogPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-http-facts-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
    store.insertSessionForTest(makeSession({ id: "sess_p" }));
    factStore = storage.facts;
    await factStore.insertMany([
      makeFact({
        id: "f_hono", subject: "nlm-memory-ts", predicate: "framework",
        value: "Hono", confidence: 0.9, sourceSessionId: "sess_p",
      }),
      makeFact({
        id: "f_fastify", subject: "nlm-memory-ts", predicate: "framework",
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

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("GET /api/recall/facts returns the current fact for subject+predicate", async () => {
    const res = await app.request("/api/recall/facts?subject=nlm-memory-ts&predicate=framework");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; results: { id: string; value: string }[] };
    expect(body.total).toBe(1);
    expect(body.results[0]?.id).toBe("f_hono");
    expect(body.results[0]?.value).toBe("Hono");
  });

  it("GET /api/recall/facts excludes superseded by default, includes with flag", async () => {
    const def = await app.request("/api/recall/facts?subject=nlm-memory-ts");
    expect(((await def.json()) as { total: number }).total).toBe(1);
    const all = await app.request("/api/recall/facts?subject=nlm-memory-ts&includeSuperseded=true");
    expect(((await all.json()) as { total: number }).total).toBe(2);
  });

  it("GET /api/recall/facts rejects invalid kind + mode", async () => {
    expect((await app.request("/api/recall/facts?kind=banana")).status).toBe(400);
    expect((await app.request("/api/recall/facts?subject=x&mode=banana")).status).toBe(400);
  });

  it("GET /api/facts/history walks the supersedence chain", async () => {
    const res = await app.request("/api/facts/history?subject=nlm-memory-ts&predicate=framework");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chains: { history: { id: string }[] }[] };
    expect(body.chains[0]?.history.map((f) => f.id)).toEqual(["f_hono", "f_fastify"]);
  });

  it("GET /api/facts/history 400s without a subject", async () => {
    expect((await app.request("/api/facts/history")).status).toBe(400);
  });

  it("GET /api/recall/facts records a fact query-log entry", async () => {
    await app.request("/api/recall/facts?subject=nlm-memory-ts&predicate=framework");
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

// Spec G.2 end-to-end: confirm the HTTP layer attaches relatedFacts when
// the caller asks for it (or is a hook source). This is the cross-runtime
// contract that ALL four hook-bearing runtimes rely on: Claude Code,
// Codex CLI, Hermes Agent, pi.dev. If this test passes, every hook runtime
// that POSTs to /api/recall with `x-recall-source: hook` will get facts
// without per-runtime changes.
describe("HTTP adapter — Spec G.2 fact injection contract", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let app: Hono;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-http-g2-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    const store = storage.sessions;
    const factStore = storage.facts;

    // Seed: two sessions tagged with the same entity, three corroborating
    // facts about it — should surface in the recall response when a hook
    // source asks for facts.
    const today = new Date().toISOString();
    store.insertSessionForTest({
      id: "sess_g2_a",
      runtime: "claude-code",
      runtimeSessionId: "g2-a",
      startedAt: today,
      endedAt: today,
      durationMin: 5,
      label: "PolySignal trade execution",
      summary: "trade execution debugging",
      status: "closed",
      transcriptKind: "claude-code-jsonl",
      transcriptPath: null,
      body: "PolySignal trade execution flow",
      entities: ["polysignal"],
      decisions: [],
      open: [],
    });
    store.insertSessionForTest({
      id: "sess_g2_b",
      runtime: "claude-code",
      runtimeSessionId: "g2-b",
      startedAt: today,
      endedAt: today,
      durationMin: 8,
      label: "PolySignal pipeline rewrite",
      summary: "pipeline refactor",
      status: "closed",
      transcriptKind: "claude-code-jsonl",
      transcriptPath: null,
      body: "PolySignal pipeline rewrite",
      entities: ["polysignal"],
      decisions: [],
      open: [],
    });

    await factStore.insertMany([
      makeFact({ id: "f_g2_1", subject: "polysignal", predicate: "uses", value: "duckdb", confidence: 0.9, sourceSessionId: "sess_g2_a" }),
      makeFact({ id: "f_g2_2", subject: "polysignal", predicate: "uses", value: "duckdb", confidence: 0.9, sourceSessionId: "sess_g2_b" }),
      makeFact({ id: "f_g2_3", subject: "polysignal", predicate: "framework", value: "hono", confidence: 0.9, sourceSessionId: "sess_g2_a" }),
      makeFact({ id: "f_g2_4", subject: "polysignal", predicate: "framework", value: "hono", confidence: 0.9, sourceSessionId: "sess_g2_b" }),
    ]);

    const recall = new RecallService({
      store,
      llm: new FixedEmbedder(unit([1, 0, 0])),
      factStore,
    });
    app = createApp({ recall, store, factStore });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("attaches relatedFacts when x-recall-source: hook is set", async () => {
    const res = await app.request("/api/recall?q=polysignal&mode=keyword", {
      headers: { "x-recall-source": "hook", "x-recall-runtime": "claude-code" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { id: string }[];
      relatedFacts?: { subject: string; predicate: string; value: string; corroborationCount: number }[];
    };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.relatedFacts).toBeDefined();
    expect(body.relatedFacts!.length).toBeGreaterThanOrEqual(2);
    const usesFact = body.relatedFacts!.find((f) => f.predicate === "uses");
    expect(usesFact?.value).toBe("duckdb");
    expect(usesFact?.corroborationCount).toBe(2);
  });

  it("attaches relatedFacts when ?withFacts=true is explicit", async () => {
    const res = await app.request("/api/recall?q=polysignal&mode=keyword&withFacts=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relatedFacts?: unknown[] };
    expect(Array.isArray(body.relatedFacts)).toBe(true);
    expect(body.relatedFacts!.length).toBeGreaterThan(0);
  });

  it("omits relatedFacts for default HTTP callers (no header, no flag)", async () => {
    const res = await app.request("/api/recall?q=polysignal&mode=keyword");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relatedFacts?: unknown[] };
    expect(body.relatedFacts).toBeUndefined();
  });

  it("respects ?withFacts=false even from a hook source", async () => {
    const res = await app.request("/api/recall?q=polysignal&mode=keyword&withFacts=false", {
      headers: { "x-recall-source": "hook" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relatedFacts?: unknown[] };
    expect(body.relatedFacts).toBeUndefined();
  });

  it("Hermes Agent pre-turn endpoint renders facts in its context block", async () => {
    const res = await app.request("/api/hook/hermes-agent/pre-turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "hermes_test_session_xxxxxx",
        user_message: "what did we decide about polysignal storage",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { context: string | null };
    expect(typeof body.context).toBe("string");
    expect(body.context).toContain("## Known facts about top entities");
    expect(body.context).toContain("polysignal uses: duckdb");
  });

  it("NLM_HOOK_INJECT_FACTS=0 disables fact attachment even on hook source", async () => {
    process.env["NLM_HOOK_INJECT_FACTS"] = "0";
    try {
      const res = await app.request("/api/recall?q=polysignal&mode=keyword", {
        headers: { "x-recall-source": "hook" },
      });
      const body = (await res.json()) as { relatedFacts?: unknown[] };
      expect(body.relatedFacts).toBeUndefined();
    } finally {
      delete process.env["NLM_HOOK_INJECT_FACTS"];
    }
  });
});

// Local-only middleware. The default test setup skips the gate via VITEST.
// This block exercises the gate explicitly by unsetting both env signals so
// the browser-fetch heuristics (Origin / Sec-Fetch-Site) actually run.
describe("HTTP local-only gate", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let app: Hono;
  let savedVitest: string | undefined;
  let savedNodeEnv: string | undefined;
  let savedToken: string | undefined;
  let savedUiAuth: string | undefined;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-http-gate-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    const store = storage.sessions;
    savedVitest = process.env["VITEST"];
    savedNodeEnv = process.env["NODE_ENV"];
    savedToken = process.env["NLM_MCP_TOKEN"];
    savedUiAuth = process.env["NLM_UI_AUTH"];
    delete process.env["VITEST"];
    delete process.env["NODE_ENV"];
    process.env["NLM_MCP_TOKEN"] = "test-token";
    process.env["NLM_UI_AUTH"] = "cookie";
    const recall = new RecallService({ store, llm: new FixedEmbedder(unit([1, 0, 0])) });
    app = createApp({ recall, store, liveStore: store });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
    if (savedVitest === undefined) delete process.env["VITEST"];
    else process.env["VITEST"] = savedVitest;
    if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = savedNodeEnv;
    if (savedToken === undefined) delete process.env["NLM_MCP_TOKEN"];
    else process.env["NLM_MCP_TOKEN"] = savedToken;
    if (savedUiAuth === undefined) delete process.env["NLM_UI_AUTH"];
    else process.env["NLM_UI_AUTH"] = savedUiAuth;
  });

  it("allows /api/health with no auth headers (liveness probe)", async () => {
    const res = await app.request("/api/health", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(200);
  });

  it("rejects /api/dataset without Origin and without Bearer (the original bug surface)", async () => {
    const res = await app.request("/api/dataset", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(401);
  });

  it("rejects /api/dataset when a Sec-Fetch-Site header alone is set (no cookie, no Bearer)", async () => {
    // Sec-Fetch-Site is spoofable by any HTTP client reaching the port.
    // The gate must NOT treat it as auth — that would re-open the
    // port-forward bypass we just closed.
    const res = await app.request("/api/dataset", {
      headers: { host: "localhost:3940", "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(401);
  });

  it("allows /api/dataset with a valid session cookie (UI path)", async () => {
    const { deriveSessionValue, SESSION_COOKIE_NAME } = await import("../../src/http/ui-auth.js");
    const cookieValue = deriveSessionValue("test-token");
    const res = await app.request("/api/dataset", {
      headers: {
        host: "localhost:3940",
        cookie: `${SESSION_COOKIE_NAME}=${cookieValue}`,
      },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("allows /api/dataset with a valid Bearer (programmatic path)", async () => {
    const res = await app.request("/api/dataset", {
      headers: { host: "localhost:3940", authorization: "Bearer test-token" },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("rejects /api/dataset with a forged cookie (different token)", async () => {
    const { deriveSessionValue, SESSION_COOKIE_NAME } = await import("../../src/http/ui-auth.js");
    const cookieValue = deriveSessionValue("attacker-guess");
    const res = await app.request("/api/dataset", {
      headers: {
        host: "localhost:3940",
        cookie: `${SESSION_COOKIE_NAME}=${cookieValue}`,
      },
    });
    expect(res.status).toBe(401);
  });
});

// UI gate. The static SPA used to be served without auth — any port-forward
// attacker could fetch /ui/index.html and the JS bundle. The gate now
// requires a session cookie minted from NLM_MCP_TOKEN via /ui/auth.
describe("HTTP UI gate", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let app: Hono;
  let savedVitest: string | undefined;
  let savedNodeEnv: string | undefined;
  let savedToken: string | undefined;
  let savedUiAuth: string | undefined;
  const uiDist = resolve(__dirname, "../../dist/ui");

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-ui-gate-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    const store = storage.sessions;
    savedVitest = process.env["VITEST"];
    savedNodeEnv = process.env["NODE_ENV"];
    savedToken = process.env["NLM_MCP_TOKEN"];
    savedUiAuth = process.env["NLM_UI_AUTH"];
    delete process.env["VITEST"];
    delete process.env["NODE_ENV"];
    process.env["NLM_MCP_TOKEN"] = "test-token";
    process.env["NLM_UI_AUTH"] = "cookie";
    const recall = new RecallService({ store, llm: new FixedEmbedder(unit([1, 0, 0])) });
    app = createApp({ recall, store, liveStore: store, uiDist });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
    if (savedVitest === undefined) delete process.env["VITEST"];
    else process.env["VITEST"] = savedVitest;
    if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = savedNodeEnv;
    if (savedToken === undefined) delete process.env["NLM_MCP_TOKEN"];
    else process.env["NLM_MCP_TOKEN"] = savedToken;
    if (savedUiAuth === undefined) delete process.env["NLM_UI_AUTH"];
    else process.env["NLM_UI_AUTH"] = savedUiAuth;
  });

  it("redirects /ui/pulse to /ui/auth when no cookie is present", async () => {
    const res = await app.request("/ui/pulse");
    expect([301, 302, 303, 307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toContain("/ui/auth");
    expect(res.headers.get("location")).toContain("next=");
  });

  it("serves /ui/auth without a cookie (bootstrap entrypoint must be reachable)", async () => {
    const res = await app.request("/ui/auth");
    expect(res.status).toBe(200);
    const body = await res.text();
    // Instructional page directs users to the CLI bootstrap. No paste form.
    expect(body).toContain("nlm ui");
    expect(body).not.toMatch(/<input[^>]*name="t"/);
  });

  it("/ui/auth?nonce=<valid> mints a cookie, redirects, and is single-use", async () => {
    // Mint via the Bearer-protected nonce endpoint, then redeem via browser path.
    const mintRes = await app.request("/api/ui-bootstrap-nonce", {
      method: "POST",
      headers: { host: "localhost:3940", authorization: "Bearer test-token" },
    });
    expect(mintRes.status).toBe(200);
    const { nonce } = (await mintRes.json()) as { nonce: string };

    const first = await app.request(`/ui/auth?nonce=${encodeURIComponent(nonce)}&next=/ui/pulse`);
    expect([301, 302, 303, 307, 308]).toContain(first.status);
    expect(first.headers.get("location")).toBe("/ui/pulse");
    const setCookie = first.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^nlm_ui_session=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");

    // Second attempt with the same nonce must NOT mint a cookie.
    const second = await app.request(`/ui/auth?nonce=${encodeURIComponent(nonce)}`);
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(second.status).toBe(200);
  });

  it("/ui/auth?nonce=<wrong> returns the same instructions page as no-nonce (no oracle)", async () => {
    const wrongRes = await app.request("/ui/auth?nonce=fake-nonce-value");
    const emptyRes = await app.request("/ui/auth");
    expect(wrongRes.status).toBe(emptyRes.status);
    expect(await wrongRes.text()).toBe(await emptyRes.text());
    expect(wrongRes.headers.get("set-cookie")).toBeNull();
  });

  it("nonce endpoint requires Bearer (or cookie) — anonymous callers can't mint", async () => {
    const res = await app.request("/api/ui-bootstrap-nonce", {
      method: "POST",
      headers: { host: "localhost:3940" },
    });
    expect(res.status).toBe(401);
  });

  it("/ui/auth?nonce=<valid>&next=https://evil.com collapses to /ui/ (open-redirect guard)", async () => {
    const mintRes = await app.request("/api/ui-bootstrap-nonce", {
      method: "POST",
      headers: { host: "localhost:3940", authorization: "Bearer test-token" },
    });
    const { nonce } = (await mintRes.json()) as { nonce: string };
    const res = await app.request(`/ui/auth?nonce=${encodeURIComponent(nonce)}&next=https://evil.com`);
    expect(res.headers.get("location")).toBe("/ui/");
  });

  it("allows /ui/pulse with a valid session cookie", async () => {
    const { deriveSessionValue, SESSION_COOKIE_NAME } = await import("../../src/http/ui-auth.js");
    const cookieValue = deriveSessionValue("test-token");
    const res = await app.request("/ui/pulse", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects /ui/pulse with a cookie forged under a different token", async () => {
    const { deriveSessionValue, SESSION_COOKIE_NAME } = await import("../../src/http/ui-auth.js");
    const cookieValue = deriveSessionValue("attacker-guess");
    const res = await app.request("/ui/pulse", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
    });
    expect([301, 302, 303, 307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toContain("/ui/auth");
  });

  it("/ui/logout clears the cookie", async () => {
    const res = await app.request("/ui/logout", { method: "POST" });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");
  });

  it("rolls the cookie forward on every authenticated /ui/* hit (no fixed expiry)", async () => {
    const { deriveSessionValue, SESSION_COOKIE_NAME } = await import("../../src/http/ui-auth.js");
    const cookieValue = deriveSessionValue("test-token");
    const res = await app.request("/ui/pulse", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    // Re-issued with fresh Max-Age so an actively-used session never expires.
    expect(setCookie).toMatch(/^nlm_ui_session=/);
    expect(setCookie).toMatch(/Max-Age=\d{6,}/);
  });

  it("rolls the cookie forward on every authenticated /api/* hit too (SPA single-tab use)", async () => {
    const { deriveSessionValue, SESSION_COOKIE_NAME } = await import("../../src/http/ui-auth.js");
    const cookieValue = deriveSessionValue("test-token");
    const res = await app.request("/api/dataset", {
      headers: {
        host: "localhost:3940",
        cookie: `${SESSION_COOKIE_NAME}=${cookieValue}`,
      },
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/Max-Age=\d{6,}/);
  });
});

// Default config: NLM_UI_AUTH unset. /ui/* and /api/* should pass through
// the loopback Host/Origin check without requiring a cookie or Bearer.
describe("HTTP gate — default off (NLM_UI_AUTH unset)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let app: Hono;
  let savedVitest: string | undefined;
  let savedNodeEnv: string | undefined;
  let savedToken: string | undefined;
  let savedUiAuth: string | undefined;
  const uiDist = resolve(__dirname, "../../dist/ui");

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-default-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    const store = storage.sessions;
    savedVitest = process.env["VITEST"];
    savedNodeEnv = process.env["NODE_ENV"];
    savedToken = process.env["NLM_MCP_TOKEN"];
    savedUiAuth = process.env["NLM_UI_AUTH"];
    delete process.env["VITEST"];
    delete process.env["NODE_ENV"];
    // Token set but UI auth NOT enabled — this is the default install state
    // once the new release lands.
    process.env["NLM_MCP_TOKEN"] = "test-token";
    delete process.env["NLM_UI_AUTH"];
    const recall = new RecallService({ store, llm: new FixedEmbedder(unit([1, 0, 0])) });
    app = createApp({ recall, store, liveStore: store, uiDist });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
    if (savedVitest === undefined) delete process.env["VITEST"];
    else process.env["VITEST"] = savedVitest;
    if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = savedNodeEnv;
    if (savedToken === undefined) delete process.env["NLM_MCP_TOKEN"];
    else process.env["NLM_MCP_TOKEN"] = savedToken;
    if (savedUiAuth === undefined) delete process.env["NLM_UI_AUTH"];
    else process.env["NLM_UI_AUTH"] = savedUiAuth;
  });

  it("/ui/pulse loads without a cookie", async () => {
    const res = await app.request("/ui/pulse", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(200);
  });

  it("/api/dataset is reachable without Bearer or cookie", async () => {
    const res = await app.request("/api/dataset", { headers: { host: "localhost:3940" } });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("non-loopback Host still rejected (loopback bind defense remains)", async () => {
    const res = await app.request("/api/dataset", { headers: { host: "evil.com" } });
    expect(res.status).toBe(403);
  });

  it("does NOT issue a session cookie (nothing to roll)", async () => {
    const res = await app.request("/ui/pulse", { headers: { host: "localhost:3940" } });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("HTTP gate — misconfig (NLM_UI_AUTH=cookie without NLM_MCP_TOKEN)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let app: Hono;
  let saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-misconfig-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    const store = storage.sessions;
    for (const k of ["VITEST", "NODE_ENV", "NLM_MCP_TOKEN", "NLM_UI_AUTH"]) {
      saved[k] = process.env[k];
    }
    delete process.env["VITEST"];
    delete process.env["NODE_ENV"];
    delete process.env["NLM_MCP_TOKEN"];
    process.env["NLM_UI_AUTH"] = "cookie";
    const recall = new RecallService({ store, llm: new FixedEmbedder(unit([1, 0, 0])) });
    app = createApp({ recall, store, liveStore: store });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("/api/* fails closed with a 500 (better than silent pass-through)", async () => {
    const res = await app.request("/api/dataset", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(500);
  });
});
