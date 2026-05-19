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
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { createApp } from "../../src/http/app.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { Session } from "../../src/shared/types.js";
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
    app = createApp({ recall, store, queryLogPath });
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
});
