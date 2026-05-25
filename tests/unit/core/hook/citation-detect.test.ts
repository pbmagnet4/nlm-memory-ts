import { describe, expect, it } from "vitest";
import { detectCitedIds } from "../../../../src/core/hook/citation-detect.js";

describe("detectCitedIds", () => {
  it("returns IDs that appear as substrings in the response", () => {
    const surfaced = new Set([
      "cc_sub_a139f4ab7ca5aa909",
      "cc_ff88cd96-d1f9-428c-8a97-2e4ca431acbe",
      "hm_20260427_6ff562",
    ]);
    const text =
      "Based on cc_sub_a139f4ab7ca5aa909 and hm_20260427_6ff562, we decided to use FTS5.";
    const cited = detectCitedIds(text, surfaced);
    expect(cited.sort()).toEqual(
      ["cc_sub_a139f4ab7ca5aa909", "hm_20260427_6ff562"].sort(),
    );
  });

  it("returns empty when no surfaced IDs appear in the text", () => {
    const surfaced = new Set(["cc_sub_abc123def456"]);
    expect(detectCitedIds("unrelated response text", surfaced)).toEqual([]);
  });

  it("returns empty for empty response", () => {
    expect(detectCitedIds("", new Set(["cc_sub_long_enough_id"]))).toEqual([]);
  });

  it("dedupes when an ID is cited multiple times", () => {
    const surfaced = new Set(["cc_sub_a139f4ab7ca5aa909"]);
    const text = "cc_sub_a139f4ab7ca5aa909 and again cc_sub_a139f4ab7ca5aa909";
    expect(detectCitedIds(text, surfaced)).toEqual(["cc_sub_a139f4ab7ca5aa909"]);
  });

  it("ignores IDs shorter than the minimum length to avoid false positives", () => {
    const surfaced = new Set(["a", "ab", "abc"]);
    expect(detectCitedIds("a ab abc abcdef", surfaced)).toEqual([]);
  });
});
