import { describe, expect, it } from "vitest";
import { tiebreakFactor } from "../../../../src/core/recall/metadata-tiebreaker.js";
import { tokenSet } from "../../../../src/core/recall/tokenize.js";

describe("tiebreakFactor (#308 metadata tiebreaker)", () => {
  it("returns 1 (no bonus) when no query tokens", () => {
    const f = tiebreakFactor(new Set<string>(), { entities: ["pgvector"], decisions: ["chose pgvector"] });
    expect(f).toBe(1);
  });

  it("returns 1 when the hit has no decision or entity text", () => {
    const f = tiebreakFactor(tokenSet("pgvector migration"), { entities: [], decisions: [] });
    expect(f).toBe(1);
  });

  it("returns 1 when query tokens overlap neither decisions nor entities", () => {
    const f = tiebreakFactor(tokenSet("kubernetes scaling"), {
      entities: ["pgvector"],
      decisions: ["chose pgvector over qdrant"],
    });
    expect(f).toBe(1);
  });

  it("applies the full decision-overlap bonus when every query token is in the decision text", () => {
    // Both tokens present in the decision marker → decFraction 1.0 → +0.13.
    const f = tiebreakFactor(tokenSet("pgvector qdrant"), {
      entities: [],
      decisions: ["chose pgvector over qdrant"],
    });
    expect(f).toBeCloseTo(1.13, 6);
  });

  it("scales the decision bonus by the fraction of query tokens matched", () => {
    // 1 of 2 query tokens in the decision text → decFraction 0.5 → +0.065.
    const f = tiebreakFactor(tokenSet("pgvector kubernetes"), {
      entities: [],
      decisions: ["chose pgvector over qdrant"],
    });
    expect(f).toBeCloseTo(1.065, 6);
  });

  it("adds a thin secondary entity bonus on top of decision overlap", () => {
    // Both tokens in decisions (+0.13) and both in entities (+0.02) → 1.15.
    const f = tiebreakFactor(tokenSet("pgvector qdrant"), {
      entities: ["pgvector", "qdrant"],
      decisions: ["chose pgvector over qdrant"],
    });
    expect(f).toBeCloseTo(1.15, 6);
  });

  it("never exceeds the combined cap of 1.15", () => {
    const f = tiebreakFactor(tokenSet("pgvector qdrant migration plan"), {
      entities: ["pgvector", "qdrant", "migration", "plan"],
      decisions: ["pgvector qdrant migration plan decided"],
    });
    expect(f).toBeLessThanOrEqual(1.15 + 1e-9);
  });
});
