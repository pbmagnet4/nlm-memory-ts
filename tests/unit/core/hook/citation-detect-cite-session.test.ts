/**
 * cite_session tool_use detection. Exercises the A1 sub-case added in
 * phase-1c: when the model calls cite_session with an explicit ID, the
 * detector should recognize it as a tool_use citation without relying on
 * substring serialization.
 */

import { describe, expect, it } from "vitest";
import { detectCitations } from "../../../../src/core/hook/citation-detect.js";

describe("detectCitations — cite_session tool_use channel (A1)", () => {
  it("detects a cite_session call as a tool_use citation", () => {
    const result = detectCitations({
      responseText: "Based on that session, here is my answer.",
      toolUses: [
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909"],
    });
    expect(result).toEqual([{ id: "cc_sub_a139f4ab7ca5aa909", kind: "tool_use" }]);
  });

  it("only cites a session ID that was surfaced", () => {
    const result = detectCitations({
      responseText: "",
      toolUses: [
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "cc_unsurfaced_abc123" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909"],
    });
    expect(result).toEqual([]);
  });

  it("does not double-count when cite_session and prose both reference the same ID", () => {
    const result = detectCitations({
      responseText: "Per cc_sub_a139f4ab7ca5aa909, the decision was FTS5.",
      toolUses: [
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: "cc_sub_a139f4ab7ca5aa909", kind: "tool_use" });
  });

  it("cites multiple IDs when cite_session is called multiple times", () => {
    const result = detectCitations({
      responseText: "",
      toolUses: [
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "hm_20260427_6ff562" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909", "hm_20260427_6ff562"],
    });
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.kind)).toEqual(["tool_use", "tool_use"]);
    expect(result.map((c) => c.id).sort()).toEqual(
      ["cc_sub_a139f4ab7ca5aa909", "hm_20260427_6ff562"].sort(),
    );
  });

  it("does not interfere with A2 (get_session) citations for a different ID", () => {
    const result = detectCitations({
      responseText: "",
      toolUses: [
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
        {
          name: "mcp__nlm-memory__get_session",
          input: { id: "hm_20260427_6ff562" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909", "hm_20260427_6ff562"],
    });
    expect(result).toHaveLength(2);
    expect(result.find((c) => c.id === "cc_sub_a139f4ab7ca5aa909")).toMatchObject({ kind: "tool_use" });
    expect(result.find((c) => c.id === "hm_20260427_6ff562")).toMatchObject({ kind: "tool_use" });
  });
});
