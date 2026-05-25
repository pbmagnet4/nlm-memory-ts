/**
 * /api/recall/cite-event endpoint integration. Exercises the citation log
 * append + readback via Hono app.request() against a real RecallService.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { createApp } from "../../src/http/app.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

class FixedEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> {
    return { vector: new Float32Array(768), model: "fixed-test" };
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

describe("POST /api/recall/cite-event", () => {
  let tmp: string;
  let store: SqliteSessionStore;
  let app: Hono;
  let citationLogPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-cite-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    const recall = new RecallService({ store, llm: new FixedEmbedder() });
    citationLogPath = join(tmp, "citation-log.jsonl");
    app = createApp({ recall, store, liveStore: store, citationLogPath });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("appends a citation entry and returns ok", async () => {
    const res = await app.request("/api/recall/cite-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: "conv-x",
        cited_id: "cc_sub_a139f4ab7ca5aa909",
        response_preview: "Per cc_sub_a139f4ab7ca5aa909 we chose FTS5.",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(existsSync(citationLogPath)).toBe(true);
    const lines = readFileSync(citationLogPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry["conversation_id"]).toBe("conv-x");
    expect(entry["cited_id"]).toBe("cc_sub_a139f4ab7ca5aa909");
    expect(entry["response_preview"]).toBe(
      "Per cc_sub_a139f4ab7ca5aa909 we chose FTS5.",
    );
    expect(typeof entry["ts"]).toBe("string");
  });

  it("rejects missing conversation_id", async () => {
    const res = await app.request("/api/recall/cite-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cited_id: "cc_sub_x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing cited_id", async () => {
    const res = await app.request("/api/recall/cite-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversation_id: "conv-x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-JSON body", async () => {
    const res = await app.request("/api/recall/cite-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/recall/cite-stats aggregates appended citations", async () => {
    await app.request("/api/recall/cite-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: "c1",
        cited_id: "cc_sub_aaa111",
      }),
    });
    await app.request("/api/recall/cite-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: "c2",
        cited_id: "cc_sub_aaa111",
      }),
    });
    await app.request("/api/recall/cite-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: "c3",
        cited_id: "cc_sub_bbb222",
      }),
    });

    const res = await app.request("/api/recall/cite-stats?days=7");
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      total: number;
      distinct_ids: number;
      top_ids: { id: string; count: number }[];
      log_present: boolean;
    };
    expect(stats.total).toBe(3);
    expect(stats.distinct_ids).toBe(2);
    expect(stats.log_present).toBe(true);
    expect(stats.top_ids[0]?.id).toBe("cc_sub_aaa111");
    expect(stats.top_ids[0]?.count).toBe(2);
  });

  it("GET /api/recall/cite-stats returns zero-totals when log is absent", async () => {
    const res = await app.request("/api/recall/cite-stats?days=14");
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      total: number;
      log_present: boolean;
    };
    expect(stats.total).toBe(0);
    expect(stats.log_present).toBe(false);
  });
});
