/**
 * PiAdapter parity tests. Mirrors test_adapter_pi.py — parser-only slice
 * (scan_once + record_classified are Phase D Scheduler work).
 */

import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiAdapter } from "../../../../src/core/adapters/pi.js";

const FIXTURES = resolve(__dirname, "../../../fixtures/pi");

function stem(p: string): string {
  return basename(p, ".jsonl");
}

describe("PiAdapter.parseSession — successful session", () => {
  const adapter = new PiAdapter({ sessionsPath: FIXTURES });

  it("short-successful: 2 turns, pi/1.0 runtime, ISO timestamps, pi_ id prefix", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/short-successful.jsonl`);
    expect(chunk).not.toBeNull();
    if (!chunk) return;
    expect(chunk.runtime).toBe("pi/1.0");
    expect(chunk.id.startsWith("pi_")).toBe(true);
    expect(chunk.startedAt).toBeTruthy();
    expect(chunk.endedAt).toBeTruthy();
    expect(chunk.startedAt).toMatch(/T/);
    expect(chunk.turnCount).toBe(2);
    expect(chunk.label).toBeTruthy();
  });

  it("short-successful: project_dir populated from session-event cwd", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/short-successful.jsonl`);
    expect(chunk?.projectDir).toBe("/private/tmp");
  });
});

describe("PiAdapter.parseSession — aborted session", () => {
  const adapter = new PiAdapter({ sessionsPath: FIXTURES });

  it("error-connection-abort: still ingests; user turn carries content", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/error-connection-abort.jsonl`);
    expect(chunk).not.toBeNull();
    if (!chunk) return;
    expect(chunk.runtime).toBe("pi/1.0");
    expect(chunk.id.startsWith("pi_")).toBe(true);
    expect(chunk.turnCount).toBeGreaterThanOrEqual(1);
    expect(chunk.label).toBeTruthy();
  });

  it("error session is flagged via gitBranch='aborted' sentinel", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/error-connection-abort.jsonl`);
    expect(chunk?.gitBranch).toBe("aborted");
  });
});

describe("PiAdapter.parseSession — custom_message excluded", () => {
  const adapter = new PiAdapter({ sessionsPath: FIXTURES });

  it("with-custom-message: custom_message events do not count as turns", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/with-custom-message.jsonl`);
    expect(chunk).not.toBeNull();
    if (!chunk) return;
    expect(chunk.turnCount).toBe(2); // user + assistant only
  });
});

describe("PiAdapter.discover", () => {
  it("finds all 3 fixtures", async () => {
    const adapter = new PiAdapter({ sessionsPath: FIXTURES });
    const found = await adapter.discover();
    const stems = new Set(found.map(stem));
    expect(stems).toEqual(
      new Set(["short-successful", "error-connection-abort", "with-custom-message"]),
    );
  });

  it("skips zero-byte files", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-"));
    copyFileSync(
      `${FIXTURES}/short-successful.jsonl`,
      join(tmp, "real.jsonl"),
    );
    writeFileSync(join(tmp, "empty.jsonl"), "");

    const adapter = new PiAdapter({ sessionsPath: tmp });
    const found = await adapter.discover();
    const stems = new Set(found.map(stem));
    expect(stems.has("empty")).toBe(false);
    expect(stems.has("real")).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("walks subdirectories recursively (<sessions>/<cwd-slug>/<file>.jsonl)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-nested-"));
    const slug = join(tmp, "private-tmp");
    mkdirSync(slug);
    copyFileSync(
      `${FIXTURES}/short-successful.jsonl`,
      join(slug, "nested.jsonl"),
    );
    const adapter = new PiAdapter({ sessionsPath: tmp });
    const found = await adapter.discover();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("private-tmp");
    rmSync(tmp, { recursive: true, force: true });
  });
});
