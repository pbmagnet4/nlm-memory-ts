import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSurfaced, recordSurfaced } from "../../src/core/hook/memo.js";

describe("hook memo", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-memo-"));
    process.env["NLM_HOOK_STATE_DIR"] = tmp;
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty set for an unknown conversation", () => {
    expect(loadSurfaced("conv-1").size).toBe(0);
  });

  it("records and reloads surfaced ids", () => {
    recordSurfaced("conv-1", ["sess_a", "sess_b"]);
    const got = loadSurfaced("conv-1");
    expect([...got].sort()).toEqual(["sess_a", "sess_b"]);
  });

  it("accumulates across multiple records and dedups", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    recordSurfaced("conv-1", ["sess_a", "sess_c"]);
    expect([...loadSurfaced("conv-1")].sort()).toEqual(["sess_a", "sess_c"]);
  });

  it("isolates conversations from each other", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    recordSurfaced("conv-2", ["sess_z"]);
    expect([...loadSurfaced("conv-1")]).toEqual(["sess_a"]);
    expect([...loadSurfaced("conv-2")]).toEqual(["sess_z"]);
  });

  it("loadSurfaced returns empty on a corrupt memo file rather than throwing", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    // overwrite with garbage
    writeFileSync(join(tmp, "conv-1.json"), "{not json", "utf8");
    expect(loadSurfaced("conv-1").size).toBe(0);
  });
});
