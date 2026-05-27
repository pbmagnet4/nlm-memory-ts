import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCited,
  loadCited,
  recordCited,
} from "../../src/core/hook/cite-memo.js";

describe("cite-memo", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-cite-memo-"));
    process.env["NLM_HOOK_STATE_DIR"] = tmp;
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loadCited returns empty set when no memo file exists", () => {
    expect(loadCited("conv-x").size).toBe(0);
  });

  it("recordCited persists ids; loadCited returns them on next call", () => {
    recordCited("conv-x", ["cc_a", "cc_b"]);
    expect(loadCited("conv-x")).toEqual(new Set(["cc_a", "cc_b"]));
  });

  it("recordCited unions across calls (does not overwrite)", () => {
    recordCited("conv-x", ["cc_a"]);
    recordCited("conv-x", ["cc_b", "cc_a"]);
    expect(loadCited("conv-x")).toEqual(new Set(["cc_a", "cc_b"]));
  });

  it("recordCited with empty list is a no-op (no file created)", () => {
    recordCited("conv-empty", []);
    expect(readdirSync(tmp).filter((f) => f.startsWith("conv-empty"))).toEqual([]);
  });

  it("clearCited removes the file and returns true; second call returns false", () => {
    recordCited("conv-x", ["cc_a"]);
    expect(clearCited("conv-x")).toBe(true);
    expect(clearCited("conv-x")).toBe(false);
    expect(loadCited("conv-x").size).toBe(0);
  });

  it("uses .cited.json filename suffix — parallel to surfaced memo's .json", () => {
    recordCited("conv-x", ["cc_a"]);
    const files = readdirSync(tmp);
    expect(files).toContain("conv-x.cited.json");
  });

  it("treats corrupt JSON as empty without throwing", () => {
    writeFileSync(join(tmp, "conv-bad.cited.json"), "not json", "utf8");
    expect(loadCited("conv-bad").size).toBe(0);
  });

  it("treats non-array JSON as empty without throwing", () => {
    writeFileSync(
      join(tmp, "conv-obj.cited.json"),
      JSON.stringify({ cc_a: 1 }),
      "utf8",
    );
    expect(loadCited("conv-obj").size).toBe(0);
  });

  it("filters out non-string entries from the persisted array", () => {
    writeFileSync(
      join(tmp, "conv-mixed.cited.json"),
      JSON.stringify(["cc_a", 42, null, "cc_b"]),
      "utf8",
    );
    expect(loadCited("conv-mixed")).toEqual(new Set(["cc_a", "cc_b"]));
  });

  it("sanitizes unsafe conversation IDs so the path stays inside the state dir", () => {
    recordCited("../escape/attempt", ["cc_a"]);
    const files = readdirSync(tmp);
    // No file at ../escape/attempt should exist; conversion replaces unsafe chars.
    expect(files.some((f) => f.endsWith(".cited.json"))).toBe(true);
    expect(files).not.toContain("..");
  });
});
