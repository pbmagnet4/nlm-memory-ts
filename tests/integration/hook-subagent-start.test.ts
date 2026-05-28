/**
 * POST /api/hook/subagent-start endpoint integration.
 * Verifies the parent→subagent link is appended to subagent-log.jsonl.
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

describe("POST /api/hook/subagent-start", () => {
  let tmp: string;
  let store: SqliteSessionStore;
  let app: Hono;
  let subagentLogPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-subagent-start-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    const recall = new RecallService({ store, llm: new FixedEmbedder() });
    subagentLogPath = join(tmp, "subagent-log.jsonl");
    process.env["NLM_SUBAGENT_LOG"] = subagentLogPath;
    app = createApp({ recall, store, liveStore: store });
  });

  afterEach(() => {
    store.close();
    delete process.env["NLM_SUBAGENT_LOG"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ok:true and recorded:true", async () => {
    const res = await app.request("/api/hook/subagent-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parent_conversation_id: "conv_parent_001",
        subagent_session_id: "conv_sub_abc123",
        subagent_description: "Run the content audit skill",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
    expect(json["recorded"]).toBe(true);
  });

  it("appends the parent→subagent link to subagent-log.jsonl", async () => {
    await app.request("/api/hook/subagent-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parent_conversation_id: "conv_parent_001",
        subagent_session_id: "conv_sub_abc123",
        subagent_description: "Run the content audit skill",
      }),
    });
    expect(existsSync(subagentLogPath)).toBe(true);
    const lines = readFileSync(subagentLogPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["parent_conversation_id"]).toBe("conv_parent_001");
    expect(entry["subagent_session_id"]).toBe("conv_sub_abc123");
    expect(entry["subagent_description"]).toBe("Run the content audit skill");
  });

  it("returns 400 when parent_conversation_id is missing", async () => {
    const res = await app.request("/api/hook/subagent-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subagent_session_id: "conv_sub_abc123" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when subagent_session_id is missing", async () => {
    const res = await app.request("/api/hook/subagent-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_conversation_id: "conv_parent_001" }),
    });
    expect(res.status).toBe(400);
  });
});
