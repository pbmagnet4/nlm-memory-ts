/**
 * POST /api/hook/pre-compact endpoint integration.
 * Verifies memo flush, compacted_at response, and hook-log append.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

describe("POST /api/hook/pre-compact", () => {
  let tmp: string;
  let store: SqliteSessionStore;
  let app: Hono;
  let hookLogPath: string;
  let hookStateDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-pre-compact-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    const recall = new RecallService({ store, llm: new FixedEmbedder() });
    hookLogPath = join(tmp, "hook-log.jsonl");
    hookStateDir = join(tmp, "hook-state");
    process.env["NLM_HOOK_LOG"] = hookLogPath;
    process.env["NLM_HOOK_STATE_DIR"] = hookStateDir;
    app = createApp({ recall, store, liveStore: store });
  });

  afterEach(() => {
    store.close();
    delete process.env["NLM_HOOK_LOG"];
    delete process.env["NLM_HOOK_STATE_DIR"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ok:true with flushed count and compacted_at", async () => {
    const res = await app.request("/api/hook/pre-compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: "conv_abc123" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
    expect(typeof json["flushed"]).toBe("number");
    expect(typeof json["compacted_at"]).toBe("string");
  });

  it("flushes the surfaced-ID memo file for the conversation", async () => {
    // Seed a memo file so there's something to flush.
    mkdirSync(hookStateDir, { recursive: true });
    writeFileSync(join(hookStateDir, "conv_abc123.json"), JSON.stringify(["sess_a", "sess_b"]), "utf8");

    const res = await app.request("/api/hook/pre-compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: "conv_abc123" }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["flushed"]).toBe(2);
    expect(existsSync(join(hookStateDir, "conv_abc123.json"))).toBe(false);
  });

  it("appends a pre-compact entry to hook-log.jsonl", async () => {
    await app.request("/api/hook/pre-compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: "conv_abc123" }),
    });
    expect(existsSync(hookLogPath)).toBe(true);
    const lines = readFileSync(hookLogPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["kind"]).toBe("pre-compact");
    expect(entry["conversationId"]).toBe("conv_abc123");
    expect(typeof entry["flushed"]).toBe("number");
  });

  it("returns 400 when conversation_id is missing", async () => {
    const res = await app.request("/api/hook/pre-compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
