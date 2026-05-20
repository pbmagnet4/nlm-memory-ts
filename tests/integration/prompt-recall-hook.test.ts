import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "../../src/hook/prompt-recall-hook.js";
import type { RecallHitInput } from "../../src/core/hook/select.js";

const hits = (...ids: string[]): ReadonlyArray<RecallHitInput> =>
  ids.map((id, i) => ({
    id,
    label: `Session ${id}`,
    startedAt: "2026-05-15T10:00:00.000Z",
    matchScore: 0.9 - i * 0.01,
  }));

describe("runHook", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-hook-"));
    process.env["NLM_HOOK_STATE_DIR"] = join(tmp, "state");
    process.env["NLM_HOOK_LOG"] = join(tmp, "hook-log.jsonl");
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    delete process.env["NLM_HOOK_LOG"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("shadow mode logs but returns no stdout", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      { mode: "shadow", recall: async () => hits("sess_a") },
    );
    expect(out).toBe("");
    const log = readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim();
    expect(JSON.parse(log).wouldInject).toEqual(["sess_a"]);
    expect(JSON.parse(log).mode).toBe("shadow");
  });

  it("shadow mode does not write the memo", async () => {
    await runHook(
      { prompt: "what did we decide", conversationId: "c1" },
      { mode: "shadow", recall: async () => hits("sess_a") },
    );
    expect(existsSync(join(tmp, "state", "c1.json"))).toBe(false);
  });

  it("live mode returns the pointer block and records the memo", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      { mode: "live", recall: async () => hits("sess_a", "sess_b") },
    );
    expect(out).toContain("## Possibly-relevant prior sessions (nlm-memory)");
    expect(out).toContain("sess_a");
    const memo = JSON.parse(readFileSync(join(tmp, "state", "c1.json"), "utf8"));
    expect([...memo].sort()).toEqual(["sess_a", "sess_b"]);
  });

  it("live mode dedups: a second fire does not re-surface the same session", async () => {
    const deps = { mode: "live" as const, recall: async () => hits("sess_a") };
    const first = await runHook({ prompt: "what did we decide", conversationId: "c1" }, deps);
    expect(first).toContain("sess_a");
    const second = await runHook({ prompt: "and what else did we decide", conversationId: "c1" }, deps);
    expect(second).toBe("");
  });

  it("generative prompts skip recall entirely", async () => {
    let called = false;
    const out = await runHook(
      { prompt: "draft a blog post about FTS5", conversationId: "c1" },
      { mode: "live", recall: async () => { called = true; return hits("sess_a"); } },
    );
    expect(out).toBe("");
    expect(called).toBe(false);
    const log = readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim();
    expect(JSON.parse(log).gate).toBe("generative");
  });

  it("returns empty and does not throw when recall rejects", async () => {
    const out = await runHook(
      { prompt: "what did we decide", conversationId: "c1" },
      { mode: "live", recall: async () => { throw new Error("daemon down"); } },
    );
    expect(out).toBe("");
  });
});
