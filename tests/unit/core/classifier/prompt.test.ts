/**
 * coerceClassifyResult — defensive parser over raw LLM JSON output. Focuses
 * on the Phase B.2 facts[] additions; existing fields are covered by the
 * end-to-end OllamaClient tests.
 */

import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  PREDICATE_VOCABULARY,
  coerceClassifyResult,
} from "../../../../src/core/classifier/prompt.js";

describe("coerceClassifyResult — facts", () => {
  function baseFields() {
    return {
      label: "L",
      summary: "S",
      entities: [],
      decisions: [],
      open: [],
      confidence: 0.8,
    };
  }

  it("returns an empty facts array when the key is missing entirely", () => {
    expect(coerceClassifyResult(baseFields()).facts).toEqual([]);
  });

  it("returns an empty facts array when facts is not an array", () => {
    expect(
      coerceClassifyResult({ ...baseFields(), facts: "not-an-array" }).facts,
    ).toEqual([]);
  });

  it("normalizes subject + predicate to lowercase and trims value", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "decision", subject: "NLE-Memory-TS", predicate: "Framework", value: "  Hono  " },
      ],
    });
    expect(out.facts).toEqual([
      { kind: "decision", subject: "nle-memory-ts", predicate: "framework", value: "Hono" },
    ]);
  });

  it("drops facts with predicates outside the closed vocabulary (no 'other' escape hatch)", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "decision", subject: "x", predicate: "color-of-the-bikeshed", value: "blue" },
        { kind: "decision", subject: "x", predicate: "framework", value: "Hono" },
      ],
    });
    expect(out.facts.map((f) => f.predicate)).toEqual(["framework"]);
  });

  it("PREDICATE_VOCABULARY does not include 'other'", () => {
    // Removed in Phase B.5 after pilot showed `other` was 43% of writes and
    // almost all slop. Off-vocab facts now get dropped by the coercer rather
    // than forced into a catch-all bucket.
    expect(PREDICATE_VOCABULARY).not.toContain("other");
  });

  it("drops facts missing required fields (subject, predicate, value)", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "decision", subject: "", predicate: "framework", value: "Hono" },
        { kind: "decision", subject: "x", predicate: "", value: "Hono" },
        { kind: "decision", subject: "x", predicate: "framework", value: "" },
        { kind: "decision", subject: "good", predicate: "framework", value: "Hono" },
      ],
    });
    expect(out.facts).toEqual([
      { kind: "decision", subject: "good", predicate: "framework", value: "Hono" },
    ]);
  });

  it("drops facts with an invalid kind", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "garbage", subject: "x", predicate: "framework", value: "Hono" },
        { kind: "attribute", subject: "x", predicate: "framework", value: "Hono" },
      ],
    });
    expect(out.facts.map((f) => f.kind)).toEqual(["attribute"]);
  });

  it("clamps sourceQuote to 500 chars and trims whitespace", () => {
    const long = " ".repeat(10) + "a".repeat(600) + " ".repeat(10);
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "decision", subject: "x", predicate: "framework", value: "Hono", sourceQuote: long },
      ],
    });
    expect(out.facts[0]?.sourceQuote).toBe("a".repeat(500));
  });

  it("omits sourceQuote when blank or non-string", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "decision", subject: "a", predicate: "framework", value: "v", sourceQuote: "   " },
        { kind: "decision", subject: "b", predicate: "framework", value: "v", sourceQuote: 42 },
      ],
    });
    expect(out.facts[0]?.sourceQuote).toBeUndefined();
    expect(out.facts[1]?.sourceQuote).toBeUndefined();
  });
});

describe("CLASSIFIER_SYSTEM_PROMPT", () => {
  it("includes the facts field in the requested JSON shape", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"facts"');
  });

  it("inlines the predicate vocabulary so the LLM sees the closed list", () => {
    for (const p of PREDICATE_VOCABULARY) {
      expect(CLASSIFIER_SYSTEM_PROMPT).toContain(p);
    }
  });
});
