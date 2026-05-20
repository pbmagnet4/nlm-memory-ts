import { describe, expect, it } from "vitest";
import { RecallService } from "../../../src/core/recall/recall-service.js";
import type { LLMClient, EmbedResult } from "../../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../../src/ports/llm-client.js";
import type {
  KeywordNeighbor,
  SessionStore,
  SemanticNeighbor,
} from "../../../src/ports/session-store.js";
import type { Session } from "../../../src/shared/types.js";
import { makeSession } from "../../fixtures/sessions.js";

// Fake store: keyword and semantic hits are pre-baked. Unit tests here cover
// RecallService orchestration (filter, merge, limit, error handling) — not
// keyword ranking quality, which is covered by the FTS integration tests.
class InMemoryStore implements SessionStore {
  listCalls = 0;
  getByIdsCalls = 0;
  constructor(
    private readonly sessions: Session[],
    private readonly neighbors: SemanticNeighbor[] = [],
    private readonly keywordHits: KeywordNeighbor[] = [],
  ) {}
  async list(): Promise<ReadonlyArray<Session>> {
    this.listCalls += 1;
    return this.sessions;
  }
  async getById(id: string): Promise<Session | null> {
    return this.sessions.find((s) => s.id === id) ?? null;
  }
  async getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>> {
    this.getByIdsCalls += 1;
    return this.sessions.filter((s) => ids.includes(s.id));
  }
  async semanticSearch(): Promise<ReadonlyArray<SemanticNeighbor>> {
    return this.neighbors;
  }
  async keywordSearch(): Promise<ReadonlyArray<KeywordNeighbor>> {
    return this.keywordHits;
  }
  async updateStatus(): Promise<void> {}
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

const corpus: Session[] = [
  makeSession({
    id: "a",
    label: "Hono router setup",
    entities: ["NLM"],
    decisions: ["chose Hono over Express"],
  }),
  makeSession({
    id: "b",
    label: "pgvector migration plan",
    entities: ["NLM", "Postgres"],
    open: ["timing of cutover"],
  }),
  makeSession({
    id: "c",
    label: "unrelated session",
    entities: ["Other"],
  }),
];

describe("RecallService.search", () => {
  it("returns empty result when query and filters are all blank", async () => {
    const svc = new RecallService({
      store: new InMemoryStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ query: "" });
    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("keyword mode surfaces store keyword hits ranked by store score", async () => {
    const store = new InMemoryStore(corpus, [], [
      { sessionId: "b", score: 9.2 },
      { sessionId: "a", score: 2.1 },
    ]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "pgvector", mode: "keyword" });
    expect(result.results.map((r) => r.id)).toEqual(["b", "a"]);
    expect(result.results[0]?.matchScore).toBe(9.2);
  });

  it("keyword mode populates matchedIn from the resolved session", async () => {
    const store = new InMemoryStore(corpus, [], [{ sessionId: "b", score: 5 }]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "pgvector", mode: "keyword" });
    expect(result.results[0]?.matchedIn).toEqual(["label"]);
  });

  it("entity filter restricts the keyword corpus", async () => {
    const store = new InMemoryStore(corpus, [], [
      { sessionId: "b", score: 5 },
      { sessionId: "c", score: 4 },
    ]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "session", mode: "keyword", entity: "NLM" });
    expect(result.results.every((r) => r.entities.includes("NLM"))).toBe(true);
    expect(result.results.map((r) => r.id)).not.toContain("c");
  });

  it("semantic mode returns ollama_unreachable when the embedder fails", async () => {
    const svc = new RecallService({
      store: new InMemoryStore(corpus),
      llm: new StubEmbedder(true),
    });
    const result = await svc.search({ query: "anything", mode: "semantic" });
    expect(result.modeUnavailable).toBe("ollama_unreachable");
    expect(result.results).toEqual([]);
  });

  it("hybrid mode degrades to keyword scores when semantic is unavailable", async () => {
    const store = new InMemoryStore(corpus, [], [{ sessionId: "b", score: 7 }]);
    const svc = new RecallService({ store, llm: new StubEmbedder(true) });
    const result = await svc.search({ query: "pgvector", mode: "hybrid" });
    expect(result.modeUnavailable).toBe("ollama_unreachable");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe("b");
  });

  it("semantic mode reports cosine similarity computed from L2 distance of unit vectors", async () => {
    const store = new InMemoryStore(corpus, [{ sessionId: "a", distance: 0 }]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "anything", mode: "semantic" });
    expect(result.results[0]?.matchScore).toBe(1);
  });

  it("hybrid mode blends 0.4 * kw + 0.6 * sem after per-leg normalization", async () => {
    const store = new InMemoryStore(
      corpus,
      [{ sessionId: "b", distance: 0 }],
      [{ sessionId: "b", score: 9.2 }],
    );
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "pgvector", mode: "hybrid" });
    const top = result.results[0];
    expect(top?.id).toBe("b");
    // kwNorm = 1 (only hit / its own max), semNorm = 1 (distance 0) => 0.4 + 0.6 = 1
    expect(top?.matchScore).toBeCloseTo(1, 4);
    expect(top?.keywordScore).toBe(1);
    expect(top?.semanticScore).toBe(1);
  });

  it("clamps limit to MAX_LIMIT (100) and at least 1", async () => {
    const store = new InMemoryStore(corpus, [], [{ sessionId: "b", score: 5 }]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const big = await svc.search({ query: "session", mode: "keyword", limit: 9999 });
    expect(big.limit).toBe(100);
    const small = await svc.search({ query: "session", mode: "keyword", limit: 0 });
    expect(small.limit).toBe(1);
  });

  it("resolves only the hit sessions and never loads the full corpus", async () => {
    const big: Session[] = Array.from({ length: 100 }, (_, i) =>
      makeSession({ id: `s${i}`, label: `session ${i}` }),
    );
    const store = new InMemoryStore(big, [], [
      { sessionId: "s7", score: 9 },
      { sessionId: "s42", score: 8 },
    ]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "anything", mode: "keyword" });
    expect(result.results.map((r) => r.id)).toEqual(["s7", "s42"]);
    expect(store.listCalls).toBe(0);
    expect(store.getByIdsCalls).toBe(1);
  });
});
