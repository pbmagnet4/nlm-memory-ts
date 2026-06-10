import { describe, expect, it } from "vitest";
import { extractRecallQuery } from "../../../../src/core/hook/query-extract.js";

describe("extractRecallQuery", () => {
  it("returns null for pure conversational messages", () => {
    expect(extractRecallQuery("yes please")).toBeNull();
    expect(extractRecallQuery("ok")).toBeNull();
    expect(extractRecallQuery("sounds good")).toBeNull();
    expect(extractRecallQuery("yes")).toBeNull();
    expect(extractRecallQuery("   ")).toBeNull();
  });

  it("returns null when fewer than 2 content words remain after stopword removal", () => {
    expect(extractRecallQuery("can you")).toBeNull();
    expect(extractRecallQuery("what is the")).toBeNull();
  });

  it("extracts content words from a technical message", () => {
    const q = extractRecallQuery("can you make a plan on getting us towards an A?");
    expect(q).not.toBeNull();
    expect(q).toContain("plan");
  });

  it("preserves proper nouns and project names", () => {
    const q = extractRecallQuery("Resume the nlm-memory Wave 2 dependency upgrade");
    expect(q).not.toBeNull();
    expect(q).toContain("nlm-memory");
    expect(q).toContain("dependency");
    expect(q).toContain("upgrade");
  });

  it("removes stopwords but keeps substantive words", () => {
    const q = extractRecallQuery("what did we decide about pgvector vs Qdrant");
    expect(q).not.toBeNull();
    expect(q).toContain("decide");
    expect(q).toContain("pgvector");
    expect(q).toContain("Qdrant");
    expect(q).not.toContain("what");
    expect(q).not.toContain("did");
    expect(q).not.toContain("about");
  });

  it("normalizes case on stopword check but preserves case in output", () => {
    const q = extractRecallQuery("React 19 migration breaking changes");
    expect(q).not.toBeNull();
    expect(q).toContain("React");
    expect(q).toContain("migration");
    expect(q).toContain("breaking");
    expect(q).toContain("changes");
  });

  it("handles hyphenated tokens as single words", () => {
    const q = extractRecallQuery("better-sqlite3 native rebuild node22");
    expect(q).not.toBeNull();
    expect(q).toContain("better-sqlite3");
  });
});
