import { describe, expect, it } from "vitest";
import { formatPointerBlock } from "../../../../src/core/hook/pointer-block.js";

describe("formatPointerBlock", () => {
  it("returns an empty string for no hits", () => {
    expect(formatPointerBlock([])).toBe("");
  });

  it("renders a header, one line per hit, and the tool footer", () => {
    const block = formatPointerBlock([
      { id: "sess_a", label: "FTS5 vs pgvector decision", startedAt: "2026-05-15T10:00:00.000Z" },
      { id: "sess_b", label: "Semantic recall via sqlite-vec", startedAt: "2026-05-17T09:30:00.000Z" },
    ]);
    expect(block).toContain("## Possibly-relevant prior sessions (nlm-memory)");
    expect(block).toContain("- sess_a · FTS5 vs pgvector decision (2026-05-15)");
    expect(block).toContain("- sess_b · Semantic recall via sqlite-vec (2026-05-17)");
    expect(block).toContain("recall_sessions");
    expect(block).toContain("get_session");
    expect(block).toContain("recall_facts");
    expect(block).toContain("get_fact_history");
  });

  it("Spec G.2: renders a Known facts section when facts are present", () => {
    const block = formatPointerBlock(
      [{ id: "sess_a", label: "x", startedAt: "2026-05-15T00:00:00.000Z" }],
      [
        { subject: "polysignal", predicate: "uses", value: "duckdb", corroborationCount: 8 },
        { subject: "polysignal", predicate: "framework", value: "hono", corroborationCount: 3 },
      ],
    );
    expect(block).toContain("## Known facts about top entities");
    expect(block).toContain("- polysignal uses: duckdb [8 sessions]");
    expect(block).toContain("- polysignal framework: hono [3 sessions]");
  });

  it("Spec G.2: omits [N sessions] tag when corroboration is 1", () => {
    const block = formatPointerBlock(
      [{ id: "sess_a", label: "x", startedAt: "2026-05-15T00:00:00.000Z" }],
      [{ subject: "x", predicate: "p", value: "v", corroborationCount: 1 }],
    );
    expect(block).toContain("- x p: v");
    expect(block).not.toContain("[1 sessions]");
  });

  it("Spec G.2: renders facts-only block when there are no hits", () => {
    const block = formatPointerBlock(
      [],
      [{ subject: "x", predicate: "p", value: "v", corroborationCount: 3 }],
    );
    expect(block).toContain("## Known facts about top entities");
    expect(block).not.toContain("## Possibly-relevant prior sessions");
  });

  it("Spec G.2: empty hits AND empty facts still returns empty string", () => {
    expect(formatPointerBlock([], [])).toBe("");
  });

  it("includes summary in pointer line when present", () => {
    const block = formatPointerBlock([
      {
        id: "sess_a",
        label: "NLM architecture discussion",
        startedAt: "2026-06-09T10:00:00.000Z",
        summary: "Decided to use FTS5 for keyword recall and sqlite-vec for semantic.",
      },
    ]);
    expect(block).toContain(
      "- sess_a · NLM architecture discussion (2026-06-09) — Decided to use FTS5 for keyword recall and sqlite-vec for semantic.",
    );
  });

  it("omits summary suffix when summary is absent", () => {
    const block = formatPointerBlock([
      { id: "sess_b", label: "No summary session", startedAt: "2026-06-09T10:00:00.000Z" },
    ]);
    expect(block).toContain("- sess_b · No summary session (2026-06-09)");
    expect(block).not.toContain(" — ");
  });

  it("truncates summary at 120 characters", () => {
    const longSummary = "A".repeat(150);
    const block = formatPointerBlock([
      { id: "sess_c", label: "Long summary", startedAt: "2026-06-09T10:00:00.000Z", summary: longSummary },
    ]);
    expect(block).toContain(`— ${"A".repeat(120)}`);
    expect(block).not.toContain("A".repeat(121));
  });
});
