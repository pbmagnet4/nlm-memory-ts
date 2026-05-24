import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSessionEnd } from "../../src/hook/session-end-hook.js";
import { loadSurfaced, recordSurfaced } from "../../src/core/hook/memo.js";

describe("session-end hook", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-session-end-"));
    process.env["NLM_HOOK_STATE_DIR"] = tmp;
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("deletes the per-conversation memo when one exists", () => {
    recordSurfaced("conv-x", ["sess_1", "sess_2"]);
    expect(loadSurfaced("conv-x").size).toBe(2);
    const result = runSessionEnd("conv-x");
    expect(result.cleared).toBe(true);
    expect(result.conversationId).toBe("conv-x");
    expect(loadSurfaced("conv-x").size).toBe(0);
  });

  it("reports cleared=false when no memo file exists", () => {
    const result = runSessionEnd("never-existed");
    expect(result.cleared).toBe(false);
  });
});
