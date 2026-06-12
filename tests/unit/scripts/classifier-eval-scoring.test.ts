import { describe, expect, it } from "vitest";
import {
  aggregateExtraction,
  scoreSession,
  type SessionScore,
} from "../../../scripts/eval/extraction-scoring.js";
import { parseJudgeJson } from "../../../scripts/eval/judge.js";
import {
  JUDGE_TRANSCRIPT_CAP,
  judgeTranscript,
} from "../../../scripts/eval/classifier-eval.js";

describe("scoreSession", () => {
  it("computes precision and recall rates per surface", () => {
    const s = scoreSession(
      {
        decisionPrecision: ["supported", "supported", "unsupported"],
        decisionRecall: ["matched", "unmatched"],
        entityPrecision: ["supported", "unsupported", "supported", "supported"],
        missedDecisions: 0,
      },
      false,
    );
    expect(s.decisionPrecision).toBeCloseTo(2 / 3);
    expect(s.decisionRecall).toBeCloseTo(1 / 2);
    expect(s.entityPrecision).toBeCloseTo(3 / 4);
    expect(s.schemaFailed).toBe(false);
  });

  it("returns null (not 0) for an empty surface so it does not drag the mean", () => {
    const s = scoreSession(
      { decisionPrecision: [], decisionRecall: ["matched"], entityPrecision: [], missedDecisions: 0 },
      false,
    );
    expect(s.decisionPrecision).toBeNull();
    expect(s.entityPrecision).toBeNull();
    expect(s.decisionRecall).toBe(1);
  });

  it("marks every surface null on schema failure", () => {
    const s = scoreSession(
      { decisionPrecision: ["supported"], decisionRecall: ["matched"], entityPrecision: ["supported"], missedDecisions: 0 },
      true,
    );
    expect(s.schemaFailed).toBe(true);
    expect(s.decisionPrecision).toBeNull();
    expect(s.decisionRecall).toBeNull();
    expect(s.entityPrecision).toBeNull();
  });
});

describe("aggregateExtraction", () => {
  it("macro-averages across sessions, dropping null surfaces", () => {
    const scores: SessionScore[] = [
      { decisionPrecision: 1.0, decisionRecall: 0.5, decisionRecallTranscript: 0.5, entityPrecision: 1.0, schemaFailed: false },
      { decisionPrecision: 0.5, decisionRecall: null, decisionRecallTranscript: null, entityPrecision: 0.0, schemaFailed: false },
      { decisionPrecision: null, decisionRecall: 1.0, decisionRecallTranscript: 1.0, entityPrecision: null, schemaFailed: false },
    ];
    const a = aggregateExtraction(scores);
    expect(a.n).toBe(3);
    expect(a.scored).toBe(3);
    expect(a.schemaFailures).toBe(0);
    // decision precision: mean of [1.0, 0.5] (third is null) = 0.75 over n=2
    expect(a.decisionPrecision).toBeCloseTo(0.75);
    expect(a.decisionPrecisionN).toBe(2);
    // decision recall: mean of [0.5, 1.0] = 0.75 over n=2
    expect(a.decisionRecall).toBeCloseTo(0.75);
    expect(a.decisionRecallN).toBe(2);
    // entity precision: mean of [1.0, 0.0] = 0.5 over n=2
    expect(a.entityPrecision).toBeCloseTo(0.5);
    expect(a.entityPrecisionN).toBe(2);
  });

  it("counts schema failures and excludes them from surface means", () => {
    const scores: SessionScore[] = [
      { decisionPrecision: 1.0, decisionRecall: 1.0, decisionRecallTranscript: 1.0, entityPrecision: 1.0, schemaFailed: false },
      { decisionPrecision: null, decisionRecall: null, decisionRecallTranscript: null, entityPrecision: null, schemaFailed: true },
      { decisionPrecision: null, decisionRecall: null, decisionRecallTranscript: null, entityPrecision: null, schemaFailed: true },
    ];
    const a = aggregateExtraction(scores);
    expect(a.n).toBe(3);
    expect(a.scored).toBe(1);
    expect(a.schemaFailures).toBe(2);
    expect(a.decisionPrecision).toBe(1.0);
    expect(a.decisionPrecisionN).toBe(1);
  });

  it("yields null surface means when no session has items", () => {
    const a = aggregateExtraction([
      { decisionPrecision: null, decisionRecall: null, decisionRecallTranscript: null, entityPrecision: null, schemaFailed: false },
    ]);
    expect(a.decisionPrecision).toBeNull();
    expect(a.decisionPrecisionN).toBe(0);
  });
});

describe("parseJudgeJson", () => {
  it("parses a bare JSON object", () => {
    expect(parseJudgeJson('{"verdict":"supported"}')).toEqual({ verdict: "supported" });
  });

  it("strips markdown fences", () => {
    expect(parseJudgeJson('```json\n{"verdict":"matched"}\n```')).toEqual({ verdict: "matched" });
  });

  it("extracts a JSON object embedded in stray prose", () => {
    expect(parseJudgeJson('Here is my verdict: {"verdict":"unsupported"} done.')).toEqual({
      verdict: "unsupported",
    });
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseJudgeJson("the model refused")).toThrow();
  });
});

describe("judgeTranscript", () => {
  it("returns the body unchanged when under the cap", () => {
    const body = "a".repeat(100);
    expect(judgeTranscript(body)).toBe(body);
  });

  it("keeps head and tail and drops the middle when over the cap", () => {
    const head = "H".repeat(8_000);
    const tail = "T".repeat(8_000);
    const middle = "M".repeat(8_000);
    const out = judgeTranscript(head + middle + tail);
    expect(out.length).toBeLessThanOrEqual(JUDGE_TRANSCRIPT_CAP + 80);
    expect(out.startsWith("H")).toBe(true);
    expect(out.endsWith("T")).toBe(true);
    expect(out).toContain("truncated for judge");
    // the middle filler must be gone
    expect(out).not.toContain("M".repeat(8_000));
  });
});
