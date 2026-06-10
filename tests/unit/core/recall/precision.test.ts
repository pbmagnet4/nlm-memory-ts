import { describe, expect, it } from "vitest";
import { computePrecision } from "../../../../src/core/recall/precision.js";
import type { LogEntry } from "../../../../src/core/recall/query-log.js";
import type { CitationEntry } from "../../../../src/core/recall/citation-log.js";

const makeQueryEntry = (returnedIds: string[]): LogEntry => ({
  source: "hook",
  runtime: "claude-code",
  query: "test query",
  entity: null,
  kind: null,
  mode: "keyword",
  limit: 5,
  nResults: returnedIds.length,
  returnedIds,
});

const makeCitationEntry = (conversationId: string, citedId: string): CitationEntry => ({
  conversationId,
  citedId,
  kind: "tool_use",
});

describe("computePrecision", () => {
  it("returns zero precision when no citations match surfaced sessions", () => {
    const queries: Array<{ conversationId: string; entry: LogEntry }> = [
      { conversationId: "conv_a", entry: makeQueryEntry(["sess_1", "sess_2"]) },
    ];
    const citations: CitationEntry[] = [
      makeCitationEntry("conv_a", "sess_9"),
    ];
    const result = computePrecision(queries, citations);
    expect(result.precisionAtK).toBe(0);
    expect(result.conversationCount).toBe(1);
  });

  it("returns 1.0 when every surfaced session is cited", () => {
    const queries: Array<{ conversationId: string; entry: LogEntry }> = [
      { conversationId: "conv_a", entry: makeQueryEntry(["sess_1", "sess_2"]) },
    ];
    const citations: CitationEntry[] = [
      makeCitationEntry("conv_a", "sess_1"),
      makeCitationEntry("conv_a", "sess_2"),
    ];
    const result = computePrecision(queries, citations);
    expect(result.precisionAtK).toBe(1.0);
  });

  it("computes partial precision correctly", () => {
    const queries: Array<{ conversationId: string; entry: LogEntry }> = [
      { conversationId: "conv_a", entry: makeQueryEntry(["sess_1", "sess_2", "sess_3", "sess_4"]) },
    ];
    const citations: CitationEntry[] = [
      makeCitationEntry("conv_a", "sess_1"),
      makeCitationEntry("conv_a", "sess_2"),
    ];
    const result = computePrecision(queries, citations);
    expect(result.precisionAtK).toBeCloseTo(0.5, 5);
  });

  it("averages precision across multiple conversations", () => {
    const queries: Array<{ conversationId: string; entry: LogEntry }> = [
      { conversationId: "conv_a", entry: makeQueryEntry(["sess_1", "sess_2"]) },
      { conversationId: "conv_b", entry: makeQueryEntry(["sess_3", "sess_4"]) },
    ];
    const citations: CitationEntry[] = [
      makeCitationEntry("conv_a", "sess_1"),
      makeCitationEntry("conv_b", "sess_3"),
      makeCitationEntry("conv_b", "sess_4"),
    ];
    const result = computePrecision(queries, citations);
    // conv_a: 1/2=0.5, conv_b: 2/2=1.0 → avg = 0.75
    expect(result.precisionAtK).toBeCloseTo(0.75, 5);
    expect(result.conversationCount).toBe(2);
  });

  it("skips conversations with no surfaced sessions", () => {
    const queries: Array<{ conversationId: string; entry: LogEntry }> = [
      { conversationId: "conv_a", entry: makeQueryEntry([]) },
      { conversationId: "conv_b", entry: makeQueryEntry(["sess_1"]) },
    ];
    const citations: CitationEntry[] = [
      makeCitationEntry("conv_b", "sess_1"),
    ];
    const result = computePrecision(queries, citations);
    expect(result.conversationCount).toBe(1);
    expect(result.precisionAtK).toBe(1.0);
  });

  it("returns null precision when there are no scoreable conversations", () => {
    const result = computePrecision([], []);
    expect(result.precisionAtK).toBeNull();
    expect(result.conversationCount).toBe(0);
  });
});
