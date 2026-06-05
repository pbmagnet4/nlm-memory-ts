/**
 * Spec G.2: pickRelatedFacts unit tests. Stub FactStore lets us control
 * the (subject → facts, corroboration counts) inputs without a SQLite
 * fixture.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FactStore } from "../../../../src/ports/fact-store.js";
import type { Fact, FactHistoryChain, FactQuery, RecallHit } from "../../../../src/shared/types.js";
import { pickRelatedFacts } from "../../../../src/core/recall/related-facts.js";

function fact(subject: string, predicate: string, value: string, confidence = 0.9): Fact {
  return {
    id: `f_${Math.random()}`,
    kind: "attribute",
    subject,
    predicate,
    value,
    sourceSessionId: "sess_x",
    sourceQuote: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    supersededBy: null,
    confidence,
  };
}

function hit(id: string, entities: string[]): RecallHit {
  return {
    id,
    startedAt: "2026-06-01T00:00:00.000Z",
    label: "x",
    summary: "",
    entities,
    decisions: [],
    open: [],
    status: "active",
    matchScore: 1,
    matchedIn: ["label"],
  };
}

class ScriptedFactStore implements FactStore {
  constructor(
    private readonly bySubject: Map<string, Fact[]>,
    private readonly corroboration: Map<string, number>,
  ) {}
  async insert() {}
  async insertMany() {}
  async getById() { return null; }
  async findCurrent() { return null; }
  async list(query: FactQuery) {
    return this.bySubject.get(query.subject) ?? [];
  }
  async listBySession() { return []; }
  async markSuperseded() {}
  async upsertEmbedding() {}
  async ingestSessionFacts() {}
  async listForRecall() { return []; }
  async semanticSearch() { return []; }
  async getHistory(): Promise<ReadonlyArray<FactHistoryChain>> { return []; }
  async corroborationCounts(
    triples: ReadonlyArray<{ subject: string; predicate: string; value: string }>,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const t of triples) {
      const k = `${t.subject} ${t.predicate} ${t.value}`;
      out.set(k, this.corroboration.get(k) ?? 1);
    }
    return out;
  }
}

describe("pickRelatedFacts (Spec G.2)", () => {
  beforeEach(() => {
    delete process.env["NLM_HOOK_FACT_LIMIT"];
    delete process.env["NLM_HOOK_FACT_MIN_CORROBORATION"];
    delete process.env["NLM_HOOK_FACT_MIN_CONFIDENCE"];
  });
  afterEach(() => {
    delete process.env["NLM_HOOK_FACT_LIMIT"];
    delete process.env["NLM_HOOK_FACT_MIN_CORROBORATION"];
    delete process.env["NLM_HOOK_FACT_MIN_CONFIDENCE"];
  });

  it("returns empty when no hits", async () => {
    const store = new ScriptedFactStore(new Map(), new Map());
    expect(await pickRelatedFacts([], store)).toEqual([]);
  });

  it("returns empty when hits have no entities", async () => {
    const store = new ScriptedFactStore(new Map(), new Map());
    expect(await pickRelatedFacts([hit("a", [])], store)).toEqual([]);
  });

  it("returns top facts about top-hit entities by corroboration", async () => {
    const facts = new Map<string, Fact[]>([
      ["polysignal", [
        fact("polysignal", "uses", "duckdb"),
        fact("polysignal", "framework", "hono"),
      ]],
    ]);
    const corr = new Map([
      ["polysignal uses duckdb", 8],
      ["polysignal framework hono", 3],
    ]);
    const store = new ScriptedFactStore(facts, corr);
    const result = await pickRelatedFacts([hit("a", ["polysignal"])], store);
    expect(result).toEqual([
      { subject: "polysignal", predicate: "uses", value: "duckdb", corroborationCount: 8 },
      { subject: "polysignal", predicate: "framework", value: "hono", corroborationCount: 3 },
    ]);
  });

  it("filters out facts below the minCorroboration floor", async () => {
    const facts = new Map<string, Fact[]>([
      ["x", [fact("x", "y", "v_solo")]],
    ]);
    const corr = new Map([["x y v_solo", 1]]);
    const store = new ScriptedFactStore(facts, corr);
    const result = await pickRelatedFacts([hit("a", ["x"])], store, { minCorroboration: 2 });
    expect(result).toEqual([]);
  });

  it("filters out facts below the minConfidence threshold", async () => {
    const facts = new Map<string, Fact[]>([
      ["x", [fact("x", "y", "v", 0.5)]], // below default 0.7
    ]);
    const corr = new Map([["x y v", 5]]);
    const store = new ScriptedFactStore(facts, corr);
    const result = await pickRelatedFacts([hit("a", ["x"])], store);
    expect(result).toEqual([]);
  });

  it("dedupes by (subject, predicate) — picks most-corroborated value when both currents disagree", async () => {
    // Edge case: two current rows for same (subject, predicate) — shouldn't
    // happen by design, but the picker should still produce one row.
    const facts = new Map<string, Fact[]>([
      ["x", [fact("x", "uses", "old"), fact("x", "uses", "new")]],
    ]);
    const corr = new Map([
      ["x uses old", 2],
      ["x uses new", 10],
    ]);
    const store = new ScriptedFactStore(facts, corr);
    const result = await pickRelatedFacts([hit("a", ["x"])], store);
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe("new");
  });

  it("respects custom limit via opts", async () => {
    const facts = new Map<string, Fact[]>([
      ["x", [
        fact("x", "p1", "v1"),
        fact("x", "p2", "v2"),
        fact("x", "p3", "v3"),
      ]],
    ]);
    const corr = new Map([
      ["x p1 v1", 5],
      ["x p2 v2", 4],
      ["x p3 v3", 3],
    ]);
    const store = new ScriptedFactStore(facts, corr);
    const result = await pickRelatedFacts([hit("a", ["x"])], store, { limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("returns empty on FactStore error (fail-open)", async () => {
    class FailingStore implements FactStore {
      async insert() {}
      async insertMany() {}
      async getById() { return null; }
      async findCurrent() { return null; }
      async list(): Promise<Fact[]> { throw new Error("db down"); }
      async listBySession() { return []; }
      async markSuperseded() {}
      async upsertEmbedding() {}
      async ingestSessionFacts() {}
      async listForRecall() { return []; }
      async semanticSearch() { return []; }
      async getHistory(): Promise<ReadonlyArray<FactHistoryChain>> { return []; }
      async corroborationCounts() { return new Map<string, number>(); }
    }
    const result = await pickRelatedFacts([hit("a", ["x"])], new FailingStore());
    expect(result).toEqual([]);
  });

  it("aggregates entities across the top hits, preserving rank order", async () => {
    const facts = new Map<string, Fact[]>([
      ["a", [fact("a", "p", "va")]],
      ["b", [fact("b", "p", "vb")]],
    ]);
    const corr = new Map([
      ["a p va", 2],
      ["b p vb", 5],
    ]);
    const store = new ScriptedFactStore(facts, corr);
    const result = await pickRelatedFacts(
      [hit("h1", ["a"]), hit("h2", ["b"])],
      store,
    );
    // sorted by corroboration desc → b first
    expect(result.map((r) => r.subject)).toEqual(["b", "a"]);
  });
});
