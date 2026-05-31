/**
 * NousResearch Hermes Agent hook endpoints — integration tests.
 *
 * All three hermes-agent endpoints are tested against a real
 * SqliteSessionStore + RecallService running in-process (no network, no
 * TTY required). This mirrors the approach used in http.test.ts and
 * hook-pre-compact.test.ts.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { createApp } from "../../src/http/app.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

class NoopEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> {
    return { vector: new Float32Array(768), model: "noop" };
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

describe("hermes-agent hook endpoints", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let app: Hono;
  let citationLogPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-hermes-agent-"));
    process.env["NLM_HOOK_STATE_DIR"] = join(tmp, "hook-state");
    process.env["NLM_HOOK_LOG"] = join(tmp, "hook-log.jsonl");
    citationLogPath = join(tmp, "citation-log.jsonl");

    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    const store = storage.sessions;
    store.insertSessionForTest(
      makeSession({ id: "sess_a", label: "recall hook design", body: "recall hook design work" }),
    );
    store.insertSessionForTest(
      makeSession({ id: "sess_b", label: "sqlite migration plan", body: "database migration" }),
    );

    const recall = new RecallService({ store, llm: new NoopEmbedder() });
    app = createApp({ recall, store, citationLogPath });
  });

  afterEach(async () => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    delete process.env["NLM_HOOK_LOG"];
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // ── pre-turn ──────────────────────────────────────────────────────────────

  it("pre-turn returns context for a matching query", async () => {
    const res = await app.request("/api/hook/hermes-agent/pre-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess_hermes_1", user_message: "recall hook" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["context"]).toBe("string");
    expect((body["context"] as string).length).toBeGreaterThan(0);
    expect(body["context"]).toContain("sess_a");
  });

  it("pre-turn returns null context for a generative prompt", async () => {
    const res = await app.request("/api/hook/hermes-agent/pre-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess_hermes_2", user_message: "write a poem about autumn" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["context"]).toBeNull();
  });

  it("pre-turn returns null context for empty DB query", async () => {
    const res = await app.request("/api/hook/hermes-agent/pre-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess_hermes_3", user_message: "xyzzy completely unrelated" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["context"]).toBeNull();
  });

  it("pre-turn deduplicates: same session not re-surfaced on second fire", async () => {
    const payload = { session_id: "sess_hermes_4", user_message: "recall hook" };
    const first = await app.request("/api/hook/hermes-agent/pre-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["context"]).toBeTruthy();

    const second = await app.request("/api/hook/hermes-agent/pre-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody["context"]).toBeNull();
  });

  it("pre-turn returns 400 when session_id is missing", async () => {
    const res = await app.request("/api/hook/hermes-agent/pre-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_message: "recall hook" }),
    });
    expect(res.status).toBe(400);
  });

  // ── post-turn ─────────────────────────────────────────────────────────────

  it("post-turn detects and logs a cited session ID", async () => {
    // Prime the memo so sess_a is in the surfaced set.
    await app.request("/api/hook/hermes-agent/pre-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess_hermes_5", user_message: "recall hook" }),
    });

    const res = await app.request("/api/hook/hermes-agent/post-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess_hermes_5",
        assistant_response: "Based on sess_a, here is the answer.",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["cited"]).toBe(1);
    expect(existsSync(citationLogPath)).toBe(true);
  });

  it("post-turn returns cited=0 when no surfaced IDs appear in response", async () => {
    const res = await app.request("/api/hook/hermes-agent/post-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess_hermes_6",
        assistant_response: "No session references here.",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["cited"]).toBe(0);
  });

  it("post-turn returns 400 when session_id is missing", async () => {
    const res = await app.request("/api/hook/hermes-agent/post-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assistant_response: "some response" }),
    });
    expect(res.status).toBe(400);
  });

  // ── session-lifecycle ─────────────────────────────────────────────────────

  it("session-lifecycle start is accepted without session_id requirement", async () => {
    const res = await app.request("/api/hook/hermes-agent/session-lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "start", session_id: "sess_hermes_7" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["event"]).toBe("start");
  });

  it("session-lifecycle end clears the surfaced-ID memo", async () => {
    // Prime memo.
    await app.request("/api/hook/hermes-agent/pre-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess_hermes_8", user_message: "recall hook" }),
    });
    const memoPath = join(tmp, "hook-state", "sess_hermes_8.json");
    expect(existsSync(memoPath)).toBe(true);

    await app.request("/api/hook/hermes-agent/session-lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "end", session_id: "sess_hermes_8" }),
    });
    expect(existsSync(memoPath)).toBe(false);
  });

  it("session-lifecycle finalize clears the memo", async () => {
    await app.request("/api/hook/hermes-agent/pre-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess_hermes_9", user_message: "recall hook" }),
    });
    await app.request("/api/hook/hermes-agent/session-lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "finalize", session_id: "sess_hermes_9" }),
    });
    expect(existsSync(join(tmp, "hook-state", "sess_hermes_9.json"))).toBe(false);
  });

  it("session-lifecycle reset clears the memo", async () => {
    await app.request("/api/hook/hermes-agent/pre-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess_hermes_10", user_message: "recall hook" }),
    });
    await app.request("/api/hook/hermes-agent/session-lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "reset", session_id: "sess_hermes_10" }),
    });
    expect(existsSync(join(tmp, "hook-state", "sess_hermes_10.json"))).toBe(false);
  });

  it("session-lifecycle returns 400 for an unknown event", async () => {
    const res = await app.request("/api/hook/hermes-agent/session-lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "unknown", session_id: "sess_hermes_x" }),
    });
    expect(res.status).toBe(400);
  });
});
