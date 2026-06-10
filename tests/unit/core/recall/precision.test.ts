import { describe, expect, it } from "vitest";
import {
  computePrecision,
  computePerSourcePrecision,
} from "../../../../src/core/recall/precision.js";
import type { LogEntry } from "../../../../src/core/recall/query-log.js";
import type { CitationEntry } from "../../../../src/core/recall/citation-log.js";
import type { HookRecallEntry } from "../../../../src/core/recall/hook-recall-log.js";

const recall = (conversationId: string, injectedIds: string[]): HookRecallEntry => ({
  conversationId,
  injectedIds,
});

const makeQueryEntry = (source: string, returnedIds: string[]): LogEntry => ({
  source,
  runtime: "claude-code",
  query: "test query",
  entity: null,
  kind: null,
  mode: "keyword",
  limit: 5,
  nResults: returnedIds.length,
  returnedIds,
});

const cite = (conversationId: string, citedId: string): CitationEntry => ({
  conversationId,
  citedId,
  kind: "tool_use",
});

describe("computePrecision (hook-log surfaced ⋈ citations)", () => {
  it("returns zero precision when no citations match surfaced sessions", () => {
    const result = computePrecision(
      [recall("conv_a", ["sess_1", "sess_2"])],
      [cite("conv_a", "sess_9")],
    );
    expect(result.precisionAtK).toBe(0);
    expect(result.conversationCount).toBe(1);
  });

  it("returns 1.0 when every surfaced session is cited", () => {
    const result = computePrecision(
      [recall("conv_a", ["sess_1", "sess_2"])],
      [cite("conv_a", "sess_1"), cite("conv_a", "sess_2")],
    );
    expect(result.precisionAtK).toBe(1.0);
  });

  it("computes partial precision correctly", () => {
    const result = computePrecision(
      [recall("conv_a", ["sess_1", "sess_2", "sess_3", "sess_4"])],
      [cite("conv_a", "sess_1"), cite("conv_a", "sess_2")],
    );
    expect(result.precisionAtK).toBeCloseTo(0.5, 5);
  });

  it("averages precision across multiple conversations", () => {
    const result = computePrecision(
      [recall("conv_a", ["sess_1", "sess_2"]), recall("conv_b", ["sess_3", "sess_4"])],
      [cite("conv_a", "sess_1"), cite("conv_b", "sess_3"), cite("conv_b", "sess_4")],
    );
    // conv_a: 1/2=0.5, conv_b: 2/2=1.0 → avg = 0.75
    expect(result.precisionAtK).toBeCloseTo(0.75, 5);
    expect(result.conversationCount).toBe(2);
  });

  it("unions injected ids across multiple recall fires in one conversation", () => {
    const result = computePrecision(
      [recall("conv_a", ["sess_1"]), recall("conv_a", ["sess_2"])],
      [cite("conv_a", "sess_1")],
    );
    // surfaced = {sess_1, sess_2}, cited = {sess_1} → 0.5
    expect(result.conversationCount).toBe(1);
    expect(result.precisionAtK).toBeCloseTo(0.5, 5);
  });

  it("returns null precision when there are no scoreable conversations", () => {
    const result = computePrecision([], []);
    expect(result.precisionAtK).toBeNull();
    expect(result.conversationCount).toBe(0);
  });
});

describe("computePerSourcePrecision", () => {
  it("buckets precision by source", () => {
    const queries = [
      { conversationId: "conv_a", entry: makeQueryEntry("hook", ["s1", "s2"]) },
      { conversationId: "conv_b", entry: makeQueryEntry("session-start-hook", ["s3", "s4"]) },
    ];
    const citations = [cite("conv_a", "s1"), cite("conv_b", "s3"), cite("conv_b", "s4")];

    const { perSource, unmeasurable } = computePerSourcePrecision(queries, citations);
    const bySource = Object.fromEntries(perSource.map((p) => [p.source, p]));

    expect(bySource["hook"]?.precision).toBeCloseTo(0.5, 5);
    expect(bySource["hook"]?.conversationCount).toBe(1);
    expect(bySource["session-start-hook"]?.precision).toBeCloseTo(1.0, 5);
    expect(bySource["session-start-hook"]?.conversationCount).toBe(1);
    expect(unmeasurable).toEqual([]);
  });

  it("marks sources with no conversation id as unmeasurable, not 0%", () => {
    const queries = [
      { conversationId: "conv_a", entry: makeQueryEntry("hook", ["s1"]) },
      { conversationId: "unknown", entry: makeQueryEntry("mcp", ["s2", "s3"]) },
      { conversationId: "unknown", entry: makeQueryEntry("http", ["s4"]) },
    ];
    const citations = [cite("conv_a", "s1")];

    const { perSource, unmeasurable } = computePerSourcePrecision(queries, citations);

    expect(perSource.map((p) => p.source)).toEqual(["hook"]);
    expect(perSource[0]?.precision).toBeCloseTo(1.0, 5);
    expect(unmeasurable).toEqual(["http", "mcp"]);
  });

  it("returns empty when no source carries a usable conversation id", () => {
    const queries = [
      { conversationId: "unknown", entry: makeQueryEntry("mcp", ["s1"]) },
    ];
    const { perSource, unmeasurable } = computePerSourcePrecision(queries, []);
    expect(perSource).toEqual([]);
    expect(unmeasurable).toEqual(["mcp"]);
  });
});
