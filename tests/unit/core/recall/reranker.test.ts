import { describe, expect, it } from "vitest";
import { buildCitationBoosts, applyBoosts, type CitationBoostMap } from "../../../../src/core/recall/reranker.js";
import type { CitationEntry } from "../../../../src/core/recall/citation-log.js";

describe("buildCitationBoosts", () => {
  it("returns an empty map when no citations", () => {
    const boosts = buildCitationBoosts([]);
    expect(boosts.size).toBe(0);
  });

  it("counts citation frequency per session ID", () => {
    const citations: CitationEntry[] = [
      { conversationId: "c1", citedId: "sess_a" },
      { conversationId: "c2", citedId: "sess_a" },
      { conversationId: "c3", citedId: "sess_b" },
    ];
    const boosts = buildCitationBoosts(citations);
    expect(boosts.get("sess_a")).toBeGreaterThan(boosts.get("sess_b")!);
  });

  it("applies log scaling to boost values", () => {
    const citations: CitationEntry[] = [
      { conversationId: "c1", citedId: "sess_a" },
      { conversationId: "c2", citedId: "sess_a" },
    ];
    const boosts = buildCitationBoosts(citations);
    const boost = boosts.get("sess_a")!;
    // ALPHA * log(1 + 2) = 0.15 * log(3) ≈ 0.1648
    expect(boost).toBeCloseTo(0.15 * Math.log(3), 4);
  });

  it("assigns boost of zero to sessions with one citation", () => {
    const citations: CitationEntry[] = [{ conversationId: "c1", citedId: "sess_a" }];
    const boosts = buildCitationBoosts(citations);
    // ALPHA * log(1 + 1) = 0.15 * log(2) ≈ 0.1040
    const boost = boosts.get("sess_a")!;
    expect(boost).toBeCloseTo(0.15 * Math.log(2), 4);
  });
});

describe("applyBoosts", () => {
  it("returns original results unchanged when no boosts apply", () => {
    const results = [
      { id: "sess_x", matchScore: 1.0 },
      { id: "sess_y", matchScore: 0.5 },
    ];
    const boosts: CitationBoostMap = new Map();
    const boosted = applyBoosts(results, boosts);
    expect(boosted[0]!.id).toBe("sess_x");
    expect(boosted[1]!.id).toBe("sess_y");
  });

  it("boosts a frequently-cited session above a higher FTS5 scorer", () => {
    const citations: CitationEntry[] = Array.from({ length: 106 }, (_, i) => ({
      conversationId: `c${i}`,
      citedId: "sess_frequent",
    }));
    const boosts = buildCitationBoosts(citations);
    const results = [
      { id: "sess_new", matchScore: 1.0 },
      { id: "sess_frequent", matchScore: 0.3 },
    ];
    const boosted = applyBoosts(results, boosts);
    // sess_frequent boost: 0.15 * log(1 + 106) = 0.15 * log(107) ≈ 0.15 * 4.673 ≈ 0.701
    // adjusted: 0.3 + 0.701 ≈ 1.001, which is > 1.0
    expect(boosted[0]!.id).toBe("sess_frequent");
  });

  it("does not allow a boost to flip a zero-score result above non-zero", () => {
    const citations: CitationEntry[] = [
      { conversationId: "c1", citedId: "sess_a" },
    ];
    const boosts = buildCitationBoosts(citations);
    const results = [
      { id: "sess_new", matchScore: 0.5 },
      { id: "sess_a", matchScore: 0 },
    ];
    const boosted = applyBoosts(results, boosts);
    // sess_a has matchScore=0, so boost is NOT applied
    expect(boosted[0]!.id).toBe("sess_new");
    expect(boosted[0]!.matchScore).toBe(0.5);
    expect(boosted[1]!.id).toBe("sess_a");
    expect(boosted[1]!.matchScore).toBe(0);
  });

  it("maintains stable sort when boosts result in ties", () => {
    const citations: CitationEntry[] = [
      { conversationId: "c1", citedId: "sess_a" },
    ];
    const boosts = buildCitationBoosts(citations);
    const results = [
      { id: "sess_a", matchScore: 0.1 },
      { id: "sess_b", matchScore: 0.1 },
    ];
    const boosted = applyBoosts(results, boosts);
    // sess_a gets boosted to ~0.2104, sess_b stays at 0.1
    expect(boosted[0]!.id).toBe("sess_a");
    expect(boosted[1]!.id).toBe("sess_b");
  });

  it("handles empty results gracefully", () => {
    const boosts = new Map<string, number>([["sess_a", 0.1]]);
    const boosted = applyBoosts([], boosts);
    expect(boosted).toEqual([]);
  });
});
