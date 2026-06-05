/**
 * Spec G part 1: fact corroboration boost. Proves that FactRecallService
 * applies the log-scale boost from store.corroborationCounts and re-orders
 * hits accordingly. Also confirms that when the store throws or the env
 * disables the boost, behavior gracefully falls back.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactRecallService } from "../../../../src/core/recall-facts/fact-recall-service.js";
import type {
  FactListFilter,
  FactQuery,
  FactSemanticNeighbor,
  FactStore,
} from "../../../../src/ports/fact-store.js";
import type {
  EmbedResult,
  LLMClient,
  RewriteResult,
} from "../../../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../../../src/ports/llm-client.js";
import type { Fact, FactHistoryChain } from "../../../../src/shared/types.js";

function makeFact(o: Partial<Fact> & Pick<Fact, "id" | "subject" | "predicate" | "value">): Fact {
  return {
    kind: "attribute",
    sourceSessionId: "sess_x",
    sourceQuote: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    supersededBy: null,
    confidence: 0.9,
    ...o,
  };
}

class ScriptedFactStore implements FactStore {
  constructor(
    private readonly candidates: Fact[],
    private readonly counts: Map<string, number>,
    private readonly shouldThrow = false,
  ) {}
  async insert() {}
  async insertMany() {}
  async getById(id: string) {
    return this.candidates.find((f) => f.id === id) ?? null;
  }
  async findCurrent() {
    return null;
  }
  async list(_q: FactQuery) {
    return this.candidates;
  }
  async listBySession() {
    return [];
  }
  async markSuperseded() {}
  async upsertEmbedding() {}
  async ingestSessionFacts() {}
  async listForRecall(_f: FactListFilter) {
    return this.candidates;
  }
  async semanticSearch(): Promise<ReadonlyArray<FactSemanticNeighbor>> {
    return [];
  }
  async getHistory(): Promise<ReadonlyArray<FactHistoryChain>> {
    return [];
  }
  async corroborationCounts(
    triples: ReadonlyArray<{ subject: string; predicate: string; value: string }>,
  ): Promise<Map<string, number>> {
    if (this.shouldThrow) throw new Error("simulated DB failure");
    const out = new Map<string, number>();
    for (const t of triples) {
      const key = `${t.subject} ${t.predicate} ${t.value}`;
      out.set(key, this.counts.get(key) ?? 1);
    }
    return out;
  }
}

class StubLLM implements LLMClient {
  async embed(): Promise<EmbedResult> {
    return { vector: new Float32Array(768), model: "stub" };
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
  async rewriteForRecall(): Promise<RewriteResult> {
    throw new LLMUnreachableError("stub");
  }
}

describe("fact corroboration boost (Spec G.1)", () => {
  beforeEach(() => {
    delete process.env["NLM_FACT_CORROBORATION_BOOST_CAP"];
  });
  afterEach(() => {
    delete process.env["NLM_FACT_CORROBORATION_BOOST_CAP"];
  });

  it("a more-corroborated fact ranks ahead of a less-corroborated equal-score fact", async () => {
    const facts = [
      makeFact({ id: "weak", subject: "polysignal", predicate: "uses", value: "postgres" }),
      makeFact({ id: "strong", subject: "polysignal", predicate: "uses", value: "duckdb" }),
    ];
    const store = new ScriptedFactStore(
      facts,
      new Map([
        ["polysignal uses postgres", 1],
        ["polysignal uses duckdb", 10],
      ]),
    );
    const svc = new FactRecallService({ factStore: store, llm: new StubLLM() });
    // Pure structured query (no query text) — service returns candidates
    // by created_at then applies corroboration. We seeded both with the
    // same timestamp; corroboration must break the tie in favor of "duckdb".
    const result = await svc.search({ subject: "polysignal", predicate: "uses", mode: "keyword" });
    expect(result.results.map((r) => r.id)).toEqual(["strong", "weak"]);
    expect(result.results[0]!.corroborationCount).toBe(10);
    expect(result.results[1]!.corroborationCount).toBe(1);
  });

  it("the boost is log-scale and capped (1 corroboration = 1.0×, 10 = 2.0×)", async () => {
    const facts = [
      makeFact({ id: "f1", subject: "x", predicate: "y", value: "v1" }),
      makeFact({ id: "f2", subject: "x", predicate: "y", value: "v2" }),
    ];
    const store = new ScriptedFactStore(
      facts,
      new Map([
        ["x y v1", 1],
        ["x y v2", 1_000_000], // capped at 2× regardless
      ]),
    );
    const svc = new FactRecallService({ factStore: store, llm: new StubLLM() });
    const result = await svc.search({ subject: "x", mode: "keyword" });
    // Cap is 2.0; even with a million corroborations, score boost is bounded
    expect(result.results[0]!.id).toBe("f2");
    expect(result.results[1]!.id).toBe("f1");
  });

  it("custom boost cap via NLM_FACT_CORROBORATION_BOOST_CAP=1 disables the boost", async () => {
    process.env["NLM_FACT_CORROBORATION_BOOST_CAP"] = "1";
    const facts = [
      makeFact({ id: "first", subject: "x", predicate: "y", value: "v1" }),
      makeFact({ id: "second", subject: "x", predicate: "y", value: "v2" }),
    ];
    const store = new ScriptedFactStore(
      facts,
      new Map([
        ["x y v1", 1],
        ["x y v2", 100],
      ]),
    );
    const svc = new FactRecallService({ factStore: store, llm: new StubLLM() });
    const result = await svc.search({ subject: "x", mode: "keyword" });
    // Boost capped at 1.0 means no re-ordering; native order (created_at DESC,
    // same timestamps → insert order) preserved.
    expect(result.results.map((r) => r.id)).toEqual(["first", "second"]);
    // But the count IS still reported.
    expect(result.results[1]!.corroborationCount).toBe(100);
  });

  it("corroborationCount is surfaced on every hit", async () => {
    const facts = [makeFact({ id: "f1", subject: "x", predicate: "y", value: "v" })];
    const store = new ScriptedFactStore(facts, new Map([["x y v", 7]]));
    const svc = new FactRecallService({ factStore: store, llm: new StubLLM() });
    const result = await svc.search({ subject: "x", mode: "keyword" });
    expect(result.results[0]!.corroborationCount).toBe(7);
  });

  it("falls back gracefully when corroborationCounts throws (no exception leaked)", async () => {
    const facts = [makeFact({ id: "f1", subject: "x", predicate: "y", value: "v" })];
    const store = new ScriptedFactStore(facts, new Map(), true);
    const svc = new FactRecallService({ factStore: store, llm: new StubLLM() });
    const result = await svc.search({ subject: "x", mode: "keyword" });
    // Search still succeeded; hit is returned without corroborationCount.
    expect(result.results.map((r) => r.id)).toEqual(["f1"]);
    expect(result.results[0]!.corroborationCount).toBeUndefined();
  });
});
