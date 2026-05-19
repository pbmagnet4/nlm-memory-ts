import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveSessionStatus } from "../../../../src/core/storage/live-status.js";

function touchAt(path: string, agoMs: number): void {
  writeFileSync(path, "");
  const t = (Date.now() - agoMs) / 1000;
  utimesSync(path, t, t);
}

describe("liveSessionStatus", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nle-status-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("superseded persisted status always wins", () => {
    expect(liveSessionStatus(null, "superseded")).toBe("superseded");
    expect(liveSessionStatus("/nonexistent", "superseded")).toBe("superseded");
  });

  it("returns 'closed' when transcript path is null", () => {
    expect(liveSessionStatus(null, "active")).toBe("closed");
  });

  it("returns 'closed' when transcript file is missing", () => {
    expect(liveSessionStatus(join(tmp, "missing.jsonl"), "active")).toBe("closed");
  });

  it("returns 'active' when mtime is under 15 minutes ago", () => {
    const p = join(tmp, "fresh.jsonl");
    touchAt(p, 5 * 60 * 1000);
    expect(liveSessionStatus(p, "active")).toBe("active");
  });

  it("returns 'idle' when mtime is between 15 minutes and 24 hours", () => {
    const p = join(tmp, "stale.jsonl");
    touchAt(p, 2 * 60 * 60 * 1000);
    expect(liveSessionStatus(p, "active")).toBe("idle");
  });

  it("returns 'closed' when mtime exceeds 24 hours", () => {
    const p = join(tmp, "old.jsonl");
    touchAt(p, 48 * 60 * 60 * 1000);
    expect(liveSessionStatus(p, "active")).toBe("closed");
  });
});
