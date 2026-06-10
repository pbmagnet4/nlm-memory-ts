// tests/unit/hook/recall-over-http.test.ts
import { describe, expect, it } from "vitest";
import { extractRecallQuery } from "../../../src/core/hook/query-extract.js";

describe("recall-over-http query filtering", () => {
  it("extractRecallQuery returns null for short conversational prompts", () => {
    expect(extractRecallQuery("yes please")).toBeNull();
    expect(extractRecallQuery("ok")).toBeNull();
    expect(extractRecallQuery("proceed")).toBeNull();
  });

  it("extractRecallQuery returns a non-empty string for technical prompts", () => {
    const q = extractRecallQuery("nlm-memory dependency upgrade Wave 2");
    expect(typeof q).toBe("string");
    expect((q as string).length).toBeGreaterThan(0);
  });
});
