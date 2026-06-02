import { describe, expect, it } from "vitest";
import { isDevBuild, updateCheckCachePath } from "../../../src/cli/upgrade-helpers.js";

describe("isDevBuild", () => {
  it("returns false for a path inside node_modules (npm global)", () => {
    expect(
      isDevBuild("/Users/alice/.nvm/versions/node/v22.0.0/lib/node_modules/nlm-memory/dist/cli/nlm.js"),
    ).toBe(false);
  });

  it("returns true for a path outside node_modules (dev build)", () => {
    expect(
      isDevBuild("/Users/alice/Documents/nlm-memory-ts/dist/cli/nlm.js"),
    ).toBe(true);
  });

  it("returns false for a path that contains node_modules as a substring", () => {
    // edge case: a project literally named 'my-node_modules-project'
    expect(
      isDevBuild("/Users/alice/my-node_modules-project/dist/cli/nlm.js"),
    ).toBe(false); // contains "node_modules" as substring — treated as installed
  });

  it("returns false for a global Windows-style path", () => {
    expect(
      isDevBuild("C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\nlm-memory\\dist\\cli\\nlm.js"),
    ).toBe(false);
  });
});

describe("updateCheckCachePath", () => {
  it("returns the env-var override when set", () => {
    process.env["NLM_UPDATE_CHECK_CACHE"] = "/tmp/test-update-check.json";
    expect(updateCheckCachePath()).toBe("/tmp/test-update-check.json");
    delete process.env["NLM_UPDATE_CHECK_CACHE"];
  });

  it("returns a path inside ~/.nlm when no override is set", () => {
    delete process.env["NLM_UPDATE_CHECK_CACHE"];
    const p = updateCheckCachePath();
    expect(p).toContain(".nlm");
    expect(p).toContain("update-check.json");
  });
});
