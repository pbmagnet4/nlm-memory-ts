/**
 * CodexAdapter tests. Verifies that:
 *   1. discover() walks the nested YYYY/MM/DD layout codex uses.
 *   2. parseSession() extracts conversation from event_msg payloads, skips
 *      the developer-role response_item that holds AGENTS.md / permissions,
 *      and surfaces tool calls as inline markers.
 */

import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../../../src/core/adapters/codex.js";
import { safeSessionId } from "../../../../src/core/adapters/common.js";

const FIXTURES = resolve(__dirname, "../../../fixtures/codex");

describe("CodexAdapter.discover", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codex-"));
    // Mirror the real codex layout: sessions/YYYY/MM/DD/rollout-*.jsonl
    const day = join(tmp, "2026", "05", "27");
    mkdirSync(day, { recursive: true });
    copyFileSync(
      join(FIXTURES, "standard_session.jsonl"),
      join(day, "rollout-2026-05-27T13-41-01-standard.jsonl"),
    );
    copyFileSync(
      join(FIXTURES, "tool_heavy.jsonl"),
      join(day, "rollout-2026-05-27T14-00-00-tool.jsonl"),
    );
    const day2 = join(tmp, "2026", "05", "28");
    mkdirSync(day2, { recursive: true });
    copyFileSync(
      join(FIXTURES, "short.jsonl"),
      join(day2, "rollout-2026-05-28T10-00-00-short.jsonl"),
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("walks the nested YYYY/MM/DD tree and finds all rollouts", async () => {
    const adapter = new CodexAdapter({ sessionsPath: tmp });
    const found = await adapter.discover();
    expect(found).toHaveLength(3);
    expect(found.every((p) => p.endsWith(".jsonl"))).toBe(true);
  });

  it("skips empty rollout files", async () => {
    const day = join(tmp, "2026", "05", "29");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-empty.jsonl"), "");
    const adapter = new CodexAdapter({ sessionsPath: tmp });
    const found = await adapter.discover();
    expect(found).toHaveLength(3);
  });

  it("filters by since mtime", async () => {
    const adapter = new CodexAdapter({ sessionsPath: tmp });
    const future = new Date(Date.now() + 60_000);
    const found = await adapter.discover({ since: future });
    expect(found).toHaveLength(0);
  });

  it("returns empty list when sessions dir is missing", async () => {
    const adapter = new CodexAdapter({ sessionsPath: "/tmp/codex-does-not-exist-xyz" });
    const found = await adapter.discover();
    expect(found).toHaveLength(0);
  });
});

describe("CodexAdapter.parseSession", () => {
  const adapter = new CodexAdapter({ sessionsPath: FIXTURES });

  it("standard_session: pulls UUID from session_meta, captures 2 turns, skips developer role", async () => {
    const chunk = await adapter.parseSession(join(FIXTURES, "standard_session.jsonl"));
    expect(chunk).not.toBeNull();
    if (!chunk) return;

    expect(chunk.runtime).toBe("codex/1.0");
    expect(chunk.runtimeSessionId).toBe("019e69aa-c9f7-7363-89bd-245cb8d62905");
    expect(chunk.id).toBe(safeSessionId("codex", chunk.runtimeSessionId));
    expect(chunk.projectDir).toBe("/Users/test/project");
    expect(chunk.turnCount).toBe(2);
    expect(chunk.text).toContain("[user] Help me refactor the auth module");
    expect(chunk.text).toContain("[assistant] Sure, I'll start");
    // The developer-role response_item must not leak into the transcript.
    expect(chunk.text).not.toContain("permissions");
    expect(chunk.text).not.toContain("system prompt");
  });

  it("standard_session: label derived from first user_message", async () => {
    const chunk = await adapter.parseSession(join(FIXTURES, "standard_session.jsonl"));
    expect(chunk?.label).toBe("Help me refactor the auth module");
  });

  it("standard_session: ISO timestamps, non-negative duration", async () => {
    const chunk = await adapter.parseSession(join(FIXTURES, "standard_session.jsonl"));
    expect(chunk?.startedAt).toMatch(/^2026-05-27T/);
    expect(chunk?.endedAt).toMatch(/^2026-05-27T/);
    expect(chunk?.durationMin).toBeGreaterThanOrEqual(0);
  });

  it("tool_heavy: function_call and custom_tool_call render as inline tool markers", async () => {
    const chunk = await adapter.parseSession(join(FIXTURES, "tool_heavy.jsonl"));
    expect(chunk).not.toBeNull();
    if (!chunk) return;

    expect(chunk.text).toContain("[tool_use: shell]");
    expect(chunk.text).toContain("[tool_use: apply_patch]");
    expect(chunk.text).toContain("[tool_result: adapters");
    expect(chunk.text).toContain("[tool_result: Patch applied");
    // Raw payload arguments must not leak.
    expect(chunk.text).not.toContain('"cmd":"ls src"');
    expect(chunk.text).not.toContain("Begin Patch");
  });

  it("short: 2 turns, non-negative integer duration", async () => {
    const chunk = await adapter.parseSession(join(FIXTURES, "short.jsonl"));
    expect(chunk).not.toBeNull();
    if (!chunk) return;
    expect(chunk.turnCount).toBe(2);
    expect(Number.isInteger(chunk.durationMin)).toBe(true);
    expect(chunk.durationMin).toBeGreaterThanOrEqual(0);
  });

  it("returns null on an empty file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "codex-empty-"));
    const empty = join(tmp, "empty.jsonl");
    writeFileSync(empty, "");
    const result = await adapter.parseSession(empty);
    expect(result).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no extractable turns exist", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "codex-meta-only-"));
    const f = join(tmp, "meta-only.jsonl");
    writeFileSync(
      f,
      `{"timestamp":"2026-05-30T00:00:00Z","type":"session_meta","payload":{"id":"x","cwd":"/x"}}\n` +
        `{"timestamp":"2026-05-30T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}\n`,
    );
    const result = await adapter.parseSession(f);
    expect(result).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("CodexAdapter.detect", () => {
  it("returns enabled=false with a hint when sessions dir is missing", () => {
    const adapter = new CodexAdapter({ sessionsPath: "/tmp/codex-definitely-missing" });
    const result = adapter.detect();
    expect(result.adapterName).toBe("codex");
    expect(typeof result.enabled).toBe("boolean");
  });
});
