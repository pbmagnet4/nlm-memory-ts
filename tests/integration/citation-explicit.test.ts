/**
 * POST /api/citation/explicit endpoint integration. Verifies that the
 * cite_session MCP tool's daemon POST path writes to the citation log
 * with kind "tool_use" and source "mcp_tool".
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
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

describe("POST /api/citation/explicit", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let app: Hono;
  let citationLogPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-citation-explicit-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    const store = storage.sessions;
    const recall = new RecallService({ store, llm: new FixedEmbedder() });
    citationLogPath = join(tmp, "citation-log.jsonl");
    app = createApp({ recall, store, liveStore: store, citationLogPath });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("logs a citation entry and returns logged:true", async () => {
    const res = await app.request("/api/citation/explicit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "cc_sub_a139f4ab7ca5aa909",
        conversation_id: "conv_test_001",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["logged"]).toBe(true);
    expect(json["id"]).toBe("cc_sub_a139f4ab7ca5aa909");
    expect(json["source"]).toBe("mcp_tool");
  });

  it("writes to the citation log with kind tool_use", async () => {
    await app.request("/api/citation/explicit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "cc_sub_a139f4ab7ca5aa909",
        reason: "Confirmed FTS5 decision.",
      }),
    });
    expect(existsSync(citationLogPath)).toBe(true);
    const lines = readFileSync(citationLogPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["cited_id"]).toBe("cc_sub_a139f4ab7ca5aa909");
    expect(entry["kind"]).toBe("tool_use");
    expect(entry["response_preview"]).toBe("Confirmed FTS5 decision.");
  });

  it("returns 400 when id is missing", async () => {
    const res = await app.request("/api/citation/explicit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: "conv_001" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is not JSON", async () => {
    const res = await app.request("/api/citation/explicit", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("defaults conversation_id to mcp_tool when absent", async () => {
    await app.request("/api/citation/explicit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "cc_sub_a139f4ab7ca5aa909" }),
    });
    const lines = readFileSync(citationLogPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["conversation_id"]).toBe("mcp_tool");
  });
});
