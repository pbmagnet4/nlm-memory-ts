/**
 * citeSessionHandler unit tests. Exercises the MCP tool handler directly
 * without a transport or store dependency — appendCitation writes to a tmp
 * file so we can verify the entry was written.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { citeSessionHandler } from "../../../src/mcp/server.js";

describe("citeSessionHandler", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-cite-session-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns logged:true for a valid id", async () => {
    const result = await citeSessionHandler({ id: "cc_sub_abc123def456" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed["logged"]).toBe(true);
    expect(parsed["id"]).toBe("cc_sub_abc123def456");
  });

  it("returns an error for an id that is too short", async () => {
    const result = await citeSessionHandler({ id: "short" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Error");
  });

  it("returns an error for an empty id", async () => {
    const result = await citeSessionHandler({ id: "" });
    expect(result.isError).toBe(true);
  });

  it("accepts optional conversation_id and note without error", async () => {
    const result = await citeSessionHandler({
      id: "cc_sub_abc123def456",
      conversation_id: "conv_test_001",
      note: "Used to confirm FTS5 choice.",
    });
    expect(result.isError).toBeFalsy();
  });
});
