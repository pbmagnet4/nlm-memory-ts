import { describe, expect, it } from "vitest";
import {
  aggregate,
  scoreOne,
} from "../../../scripts/longmemeval/scorer.js";

describe("scoreOne", () => {
  it("recallAtK=1 when a gold id is in the top-k", () => {
    const r = scoreOne({
      returnedIds: ["a", "b", "gold-1", "d", "e"],
      goldIds: ["gold-1", "gold-2"],
      returnedBodies: ["", "", "", "", ""],
      answer: "anything",
      k: 5,
    });
    expect(r.recallAtK).toBe(1);
  });

  it("recallAtK=0 when no gold id appears in the top-k", () => {
    const r = scoreOne({
      returnedIds: ["a", "b", "c", "d", "e"],
      goldIds: ["gold-1"],
      returnedBodies: ["", "", "", "", ""],
      answer: "z",
      k: 5,
    });
    expect(r.recallAtK).toBe(0);
  });

  it("recallAtK respects k=3 ceiling even when gold is at position 4", () => {
    const r = scoreOne({
      returnedIds: ["a", "b", "c", "gold-1", "e"],
      goldIds: ["gold-1"],
      returnedBodies: [],
      answer: "z",
      k: 3,
    });
    expect(r.recallAtK).toBe(0);
  });

  it("sessionBodyHit=1 when answer substring appears in any returned body (case/whitespace insensitive)", () => {
    const r = scoreOne({
      returnedIds: ["a", "b"],
      goldIds: ["gold"],
      returnedBodies: [
        "irrelevant transcript content",
        "User: Where did you grow up?\nAssistant: I grew up in   Austin, Texas.",
      ],
      answer: "austin texas",
      k: 5,
    });
    expect(r.sessionBodyHit).toBe(1);
  });

  it("sessionBodyHit=0 when answer is absent from all returned bodies", () => {
    const r = scoreOne({
      returnedIds: ["a"],
      goldIds: ["gold"],
      returnedBodies: ["nothing matches here"],
      answer: "Houston",
      k: 5,
    });
    expect(r.sessionBodyHit).toBe(0);
  });

  it("coerces a numeric answer to string and matches with word boundaries", () => {
    const hit = scoreOne({
      returnedIds: ["a"],
      goldIds: ["gold"],
      returnedBodies: ["The user mentioned 3 brothers in the conversation."],
      answer: 3,
      k: 5,
    });
    expect(hit.sessionBodyHit).toBe(1);

    const miss = scoreOne({
      returnedIds: ["a"],
      goldIds: ["gold"],
      returnedBodies: ["They paid $30 for the meal and tipped 20%."],
      answer: 3,
      k: 5,
    });
    expect(miss.sessionBodyHit).toBe(0);
  });

  it("sessionBodyHit=0 when answer is empty", () => {
    const r = scoreOne({
      returnedIds: ["a"],
      goldIds: ["gold"],
      returnedBodies: ["whatever"],
      answer: "",
      k: 5,
    });
    expect(r.sessionBodyHit).toBe(0);
  });
});

describe("aggregate", () => {
  it("computes mean rates rounded to 3 decimal places", () => {
    const a = aggregate([
      { recallAtK: 1, sessionBodyHit: 1 },
      { recallAtK: 0, sessionBodyHit: 1 },
      { recallAtK: 1, sessionBodyHit: 0 },
    ]);
    expect(a.n).toBe(3);
    expect(a.recallAtK).toBeCloseTo(0.667, 3);
    expect(a.sessionBodyHitRate).toBeCloseTo(0.667, 3);
  });

  it("returns zeros for empty input", () => {
    const a = aggregate([]);
    expect(a).toEqual({ n: 0, recallAtK: 0, sessionBodyHitRate: 0 });
  });
});
