/**
 * Acceptance test for #318 — transcript-grounded decision recall.
 *
 * AUTHORED BY THE ORCHESTRATOR AS THE FIXED SPEC. The implementer must make
 * these pass WITHOUT editing this file. The formula under test:
 *
 *   decisionRecallTranscript = supported / (supported + missedDecisions)
 *
 * where `supported` is the count of "supported" verdicts in decisionPrecision
 * (candidate decisions judged faithful to the transcript = real decisions the
 * candidate captured) and `missedDecisions` is the judge's count of distinct
 * transcript decisions captured by no extracted decision. This removes the
 * biased single-model reference from the recall path entirely.
 *
 * Edge semantics (must match exactly):
 *   - denominator 0 (no real decisions anywhere) -> null, NOT 0 (undefined)
 *   - schema-failed session -> null
 */

import { describe, it, expect } from "vitest";
import { scoreSession } from "../../../scripts/eval/extraction-scoring.js";

const base = {
  decisionPrecision: [] as ("supported" | "unsupported")[],
  decisionRecall: [] as ("matched" | "unmatched")[],
  entityPrecision: [] as ("supported" | "unsupported")[],
  missedDecisions: 0,
};

describe("scoreSession transcript-grounded decision recall (#318)", () => {
  it("all real decisions captured (0 missed) -> 1.0", () => {
    const s = scoreSession(
      { ...base, decisionPrecision: ["supported", "supported"], missedDecisions: 0 },
      false,
    );
    expect(s.decisionRecallTranscript).toBe(1);
  });

  it("captured none of the real decisions -> 0", () => {
    // supported = 0, missed = 3 -> 0 / (0 + 3) = 0
    const s = scoreSession(
      { ...base, decisionPrecision: ["unsupported"], missedDecisions: 3 },
      false,
    );
    expect(s.decisionRecallTranscript).toBe(0);
  });

  it("mixed: 2 supported, 2 missed -> 0.5", () => {
    // unsupported decisions do not count toward `supported`
    const s = scoreSession(
      { ...base, decisionPrecision: ["supported", "supported", "unsupported"], missedDecisions: 2 },
      false,
    );
    expect(s.decisionRecallTranscript).toBe(0.5);
  });

  it("no decisions anywhere (0 supported, 0 missed) -> null", () => {
    const s = scoreSession({ ...base, decisionPrecision: [], missedDecisions: 0 }, false);
    expect(s.decisionRecallTranscript).toBeNull();
  });

  it("schema-failed session -> null regardless of missed count", () => {
    const s = scoreSession({ ...base, missedDecisions: 5 }, true);
    expect(s.decisionRecallTranscript).toBeNull();
  });

  it("preserves existing reference recall alongside the new field", () => {
    const s = scoreSession(
      {
        ...base,
        decisionPrecision: ["supported"],
        decisionRecall: ["matched", "unmatched"],
        missedDecisions: 1,
      },
      false,
    );
    // old reference-based recall stays available and unchanged
    expect(s.decisionRecall).toBe(0.5);
    // new transcript-grounded recall: 1 supported / (1 + 1 missed)
    expect(s.decisionRecallTranscript).toBe(0.5);
  });
});
