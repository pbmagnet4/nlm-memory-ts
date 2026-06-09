import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installScope, resetInstallScopeCache } from "../../../../src/core/signals/install-scope.js";

describe("installScope", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "nlm-install-")); resetInstallScopeCache(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("generates a stable id and persists it", () => {
    const path = join(dir, "install-id");
    const a = installScope(path);
    resetInstallScopeCache();
    const b = installScope(path);
    expect(a).toBe(b);
    expect(readFileSync(path, "utf8").trim()).toBe(a);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });

  it("memoizes within a process (same value without re-reading)", () => {
    const path = join(dir, "install-id");
    const a = installScope(path);
    const b = installScope(path);
    expect(a).toBe(b);
  });
});
