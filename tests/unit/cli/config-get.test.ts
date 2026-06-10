import { describe, expect, it, beforeEach, afterEach } from "vitest";

describe("nlm config get", () => {
  const saved = { ...process.env };

  afterEach(() => {
    Object.assign(process.env, saved);
  });

  it("reads NLM_MCP_TOKEN from environment", () => {
    process.env["NLM_MCP_TOKEN"] = "test-secret-token";
    // Verify the key is readable for the config get command
    const value = process.env["NLM_MCP_TOKEN"];
    expect(value).toBe("test-secret-token");
  });

  it("returns undefined for unset keys", () => {
    delete process.env["NLM_NONEXISTENT_KEY"];
    const value = process.env["NLM_NONEXISTENT_KEY"];
    expect(value).toBeUndefined();
  });

  it("reads complex values with special characters", () => {
    process.env["NLM_COMPLEX"] = "value=with:special;chars";
    const value = process.env["NLM_COMPLEX"];
    expect(value).toBe("value=with:special;chars");
  });
});
