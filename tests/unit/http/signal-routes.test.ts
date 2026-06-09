import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../../../src/http/app.js";
import type { SignalStore, SignalAggregationFilter } from "../../../src/ports/signal-store.js";
import type { Signal } from "../../../src/shared/types.js";

function fakeStore(): SignalStore & { rows: Signal[] } {
  const rows: Signal[] = [];
  return {
    rows,
    async insert(s) { if (!rows.some((r) => r.id === s.id)) rows.push(s); },
    async insertMany(ss) { for (const s of ss) if (!rows.some((r) => r.id === s.id)) rows.push(s); },
    async listForAggregation(_f: SignalAggregationFilter) { return rows; },
    async countSince() { return rows.length; },
    async pruneOlderThan() { return 0; },
  };
}

function appWith(store: SignalStore) {
  return createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) } as never,
    store: {} as never,
    signalStore: store,
    installScope: "install-test",
  } as never);
}

describe("POST /api/signal", () => {
  let store: ReturnType<typeof fakeStore>;
  beforeEach(() => { store = fakeStore(); });

  it("accepts a valid signal and stores it", async () => {
    const app = appWith(store);
    const res = await app.request("/api/signal", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "/r", detail: { step: "types" }, session: "s1", ts: "2026-06-09T18:00:00.000Z" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { id: string };
    expect(body.id).toMatch(/^sig_/);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.installScope).toBe("install-test");
  });

  it("rejects an invalid kind with 400", async () => {
    const app = appWith(store);
    const res = await app.request("/api/signal", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ kind: "bogus", outcome: "pass" }),
    });
    expect(res.status).toBe(400);
    expect(store.rows).toHaveLength(0);
  });

  it("rejects non-JSON with 400", async () => {
    const app = appWith(store);
    const res = await app.request("/api/signal", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/signals/failure-modes", () => {
  it("requires repo", async () => {
    const app = appWith(fakeStore());
    const res = await app.request("/api/signals/failure-modes", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(400);
  });

  it("returns a block field for a repo", async () => {
    const app = appWith(fakeStore());
    const res = await app.request("/api/signals/failure-modes?repo=/r", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { repo: string; block: string };
    expect(body.repo).toBe("/r");
    expect(typeof body.block).toBe("string");
  });
});

describe("GET /api/signals/stats", () => {
  it("returns modes + total for a window", async () => {
    const app = appWith(fakeStore());
    const res = await app.request("/api/signals/stats?days=14", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { days: number; total: number; modes: unknown[] };
    expect(body.days).toBe(14);
    expect(Array.isArray(body.modes)).toBe(true);
  });
});
