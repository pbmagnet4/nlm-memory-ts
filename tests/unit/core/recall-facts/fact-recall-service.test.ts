/**
 * FactRecallService unit tests against an in-memory FactStore + fake LLM.
 * Mirrors the recall-service.test.ts pattern.
 */

import { describe, expect, it } from "vitest";
import { FactRecallService } from "../../../../src/core/recall-facts/fact-recall-service.js";
import type {
  FactListFilter,
  FactSemanticNeighbor,
  FactStore,
} from "../../../../src/ports/fact-store.js";
import type { EmbedResult, LLMClient } from "../../../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../../../src/ports/llm-client.js";
import type { Fact, FactHistoryChain } from "../../../../src/shared/types.js";
import { makeFact } from "../../../fixtures/facts.js";

class InMemoryFactStore implements FactStore {
  constructor(
    private readonly facts: Fact[],
    private readonly neighbors: FactSemanticNeighbor[] = [],
  ) {}
  async insert(): Promise<void> {}
  async insertMany(): Promise<void> {}
  async getById(id: string): Promise<Fact | null> {
    return this.facts.find((f) => f.id === id) ?? null;
  }
  async findCurrent(subject: string, predicate: string): Promise<Fact | null> {
    return this.facts.find(
      (f) =>
        f.subject === subject &&
        f.predicate === predicate &&
        f.supersededBy === null,
    ) ?? null;
  }
  async list(): Promise<ReadonlyArray<Fact>> {
    return this.facts;
  }
  async listBySession(): Promise<ReadonlyArray<Fact>> {
    return this.facts;
  }
  async markSuperseded(): Promise<void> {}
  async listForRecall(filter: FactListFilter): Promise<ReadonlyArray<Fact>> {
    return this.facts.filter((f) => {
      if (filter.subject !== undefined && f.subject !== filter.subject) return false;
      if (filter.predicate !== undefined && f.predicate !== filter.predicate) return false;
      if (filter.kind !== undefined && f.kind !== filter.kind) return false;
      if (filter.minConfidence !== undefined && f.confidence < filter.minConfidence) return false;
      if (filter.includeSuperseded !== true && f.supersededBy !== null) return false;
      return true;
    });
  }
  async semanticSearch(): Promise<ReadonlyArray<FactSemanticNeighbor>> {
    return this.neighbors;
  }
  async getHistory(): Promise<ReadonlyArray<FactHistoryChain>> {
    return [];
  }
  async upsertEmbedding(): Promise<void> {}
  async ingestSessionFacts(): Promise<void> {}
}

class StubEmbedder implements LLMClient {
  constructor(private readonly fail: boolean = false) {}
  async embed(): Promise<EmbedResult> {
    if (this.fail) throw new LLMUnreachableError("ollama");
    return { vector: new Float32Array([1, 0, 0]), model: "stub" };
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

const corpus: Fact[] = [
  makeFact({
    id: "f_hono",
    kind: "decision",
    subject: "nlm-memory-ts",
    predicate: "framework",
    value: "Hono",
    confidence: 0.9,
  }),
  makeFact({
    id: "f_endpoint",
    kind: "attribute",
    subject: "mac-pro-llm-host",
    predicate: "endpoint",
    value: "http://macpro:8080/v1",
    confidence: 0.85,
  }),
  makeFact({
    id: "f_model",
    kind: "attribute",
    subject: "mac-pro-llm-host",
    predicate: "model",
    value: "qwen2.5-3b",
    confidence: 0.8,
  }),
  makeFact({
    id: "f_lowconf",
    kind: "decision",
    subject: "other",
    predicate: "framework",
    value: "Hono",
    confidence: 0.5,
  }),
  makeFact({
    id: "f_superseded",
    kind: "decision",
    subject: "nlm-memory-ts",
    predicate: "framework",
    value: "Fastify",
    confidence: 0.9,
    supersededBy: "f_hono",
  }),
];

describe("FactRecallService.search (keyword)", () => {
  it("returns empty when no query and no structured filter", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({});
    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("exact subject + predicate returns current fact (no query text)", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({
      subject: "nlm-memory-ts",
      predicate: "framework",
    });
    expect(result.total).toBe(1);
    expect(result.results[0]?.id).toBe("f_hono");
    expect(result.results[0]?.value).toBe("Hono");
  });

  it("excludes superseded facts by default", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ subject: "nlm-memory-ts" });
    expect(result.results.map((r) => r.id)).toEqual(["f_hono"]);
  });

  it("includeSuperseded=true returns the full chain", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({
      subject: "nlm-memory-ts",
      includeSuperseded: true,
    });
    expect(result.results.map((r) => r.id).sort()).toEqual(["f_hono", "f_superseded"]);
  });

  it("default minConfidence (0.6) drops low-confidence facts", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ predicate: "framework" });
    // f_lowconf has confidence 0.5; f_hono has 0.9; f_superseded is dropped
    expect(result.results.map((r) => r.id)).toEqual(["f_hono"]);
  });

  it("explicit minConfidence override widens the result set", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ predicate: "framework", minConfidence: 0.4 });
    expect(result.results.map((r) => r.id).sort()).toEqual(["f_hono", "f_lowconf"]);
  });

  it("free-text query scores against value, subject, predicate", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ query: "Hono" });
    expect(result.results[0]?.id).toBe("f_hono");
    expect(result.results[0]?.matchedIn).toContain("value");
  });

  it("kind filter narrows to attribute / decision / open", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ kind: "attribute" });
    expect(result.results.map((r) => r.id).sort()).toEqual(["f_endpoint", "f_model"]);
  });

  it("limit caps the result count", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ kind: "attribute", limit: 1 });
    expect(result.results).toHaveLength(1);
  });
});

describe("FactRecallService.search (semantic)", () => {
  it("uses sqlite-vec neighbors to rank candidates", async () => {
    const neighbors: FactSemanticNeighbor[] = [
      { factId: "f_endpoint", distance: 0.2 },
      { factId: "f_model", distance: 0.6 },
    ];
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus, neighbors),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ query: "where does the LLM run", mode: "semantic" });
    expect(result.results[0]?.id).toBe("f_endpoint");
    expect(result.results[0]?.matchedIn).toEqual(["semantic"]);
  });

  it("LLM unreachable surfaces as modeUnavailable, not an exception", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(true),
    });
    const result = await svc.search({ query: "anything", mode: "semantic" });
    expect(result.modeUnavailable).toBe("ollama_unreachable");
    expect(result.total).toBe(0);
  });
});

describe("FactRecallService.search (hybrid)", () => {
  it("merges keyword + semantic scores with 0.4/0.6 weights", async () => {
    const neighbors: FactSemanticNeighbor[] = [
      { factId: "f_endpoint", distance: 0.1 },
      { factId: "f_hono", distance: 1.4 },
    ];
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus, neighbors),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ query: "Hono", mode: "hybrid" });
    // Result should include both. Top result depends on weights — keyword
    // scores "Hono" strongly for f_hono; semantic scores f_endpoint strongly.
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("f_hono");
    expect(ids).toContain("f_endpoint");
    // Hybrid hits expose both subscores.
    for (const hit of result.results) {
      expect(hit.keywordScore).toBeDefined();
      expect(hit.semanticScore).toBeDefined();
    }
  });
});
