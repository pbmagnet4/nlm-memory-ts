/**
 * HermesAdapter parity tests against the same synthetic JSON fixtures the
 * Python pytest suite uses. Mirrors test_adapter_hermes.py.
 */

import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HermesAdapter } from "../../../../src/core/adapters/hermes.js";
import { safeSessionId } from "../../../../src/core/adapters/common.js";

const FIXTURES = resolve(__dirname, "../../../fixtures/hermes");

function stem(p: string): string {
  return basename(p, ".json");
}

describe("HermesAdapter.discover", () => {
  it("dedupes paired session + dump files (session wins) → 5 paths total", async () => {
    const adapter = new HermesAdapter({ sessionsPath: FIXTURES });
    const found = await adapter.discover();
    const stems = new Set(found.map(stem));

    expect(stems.has("session_iso")).toBe(true);
    expect(stems.has("session_unix")).toBe(true);
    expect(stems.has("request_dump")).toBe(true);
    expect(stems.has("system_only")).toBe(true);

    expect(stems.has("paired_session")).toBe(true);
    expect(stems.has("paired_request_dump")).toBe(false);

    expect(found.length).toBe(5);
  });
});

describe("HermesAdapter.parseSession", () => {
  const adapter = new HermesAdapter({ sessionsPath: FIXTURES });

  it("session_iso: 4 turns (system stripped), id prefixed hm_, non-empty timestamps", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/session_iso.json`);
    expect(chunk).not.toBeNull();
    if (!chunk) return;
    expect(chunk.runtime).toBe("hermes/1.0");
    expect(chunk.turnCount).toBe(4);
    expect(chunk.startedAt).toBeTruthy();
    expect(chunk.endedAt).toBeTruthy();
    expect(chunk.id.startsWith("hm_")).toBe(true);
  });

  it("session_unix: Unix int message timestamps get normalized to ISO strings", async () => {
    // Headline regression test for the b8a3400 class of bug.
    const chunk = await adapter.parseSession(`${FIXTURES}/session_unix.json`);
    expect(chunk).not.toBeNull();
    if (!chunk) return;
    expect(chunk.startedAt).toBeTruthy();
    expect(chunk.startedAt).toMatch(/T/);
    expect(chunk.turnCount).toBe(4);
  });

  it("request_dump: nested request.body.messages parsed, 2 turns (system stripped)", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/request_dump.json`);
    expect(chunk).not.toBeNull();
    if (!chunk) return;
    expect(chunk.turnCount).toBe(2);
    expect(chunk.startedAt).toBeTruthy();
  });

  it("system_only: returns null when no real turns exist", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/system_only.json`);
    expect(chunk).toBeNull();
  });
});

describe("safeSessionId collision resistance", () => {
  it("two Hermes session_ids with same date prefix produce distinct ids", () => {
    const a = safeSessionId("hm", "20260310_100000_abc123");
    const b = safeSessionId("hm", "20260310_100000_def456");
    expect(a).not.toBe(b);
    expect(a.startsWith("hm_")).toBe(true);
    expect(b.startsWith("hm_")).toBe(true);
  });
});
