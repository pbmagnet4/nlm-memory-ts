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
  async resolveSuccessors(ids: ReadonlyArray<string>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of ids) {
      const s = this.sessions.find((x) => x.id === id);
      if (s?.supersededBy) out.set(id, s.supersededBy);
    }
    return out;
  }
  async updateStatus(): Promise<void> {}
  async markSuperseded(): Promise<void> {}
}

class StubEmbedder implements LLMClient {
  constructor(private readonly fail: boolean = false) {}
  async embed(): Promise<EmbedResult> {
    if (this.fail) throw new LLMUnreachableError("ollama");
    return { vector: new Float32Array([1, 0, 0]), model: "stub" };
  }
  async rewriteForRecall(): Promise<never> {
    throw new Error("not used in tests");
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

  it("metadata tiebreaker (#308) reorders a BM25 near-tie toward decision overlap", async () => {
    // Two sessions essentially tied on BM25; the lower-scored one ("dec") has
    // both query tokens in its decision marker, the higher-scored one has
    // none. The capped decision bonus lifts "dec" above "raw".
    const sessions: Session[] = [
      makeSession({ id: "raw", label: "pgvector qdrant pgvector", decisions: [] }),
      makeSession({ id: "dec", label: "pgvector qdrant", decisions: ["chose pgvector over qdrant"] }),
    ];
    const store = new InMemoryStore(sessions, [], [
      { sessionId: "raw", score: 10.0 },
      { sessionId: "dec", score: 9.2 }, // 9.2 * 1.13 = 10.396 > 10.0
    ]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "pgvector qdrant", mode: "keyword" });
    expect(result.results.map((r) => r.id)).toEqual(["dec", "raw"]);
  });

  it("metadata tiebreaker cannot invert a clearly stronger BM25 match", async () => {
    // The bonus is capped at +15%; a 2x-stronger raw hit keeps its lead even
    // when the weaker hit has full decision overlap.
    const sessions: Session[] = [
      makeSession({ id: "strong", label: "pgvector qdrant pgvector qdrant", decisions: [] }),
      makeSession({ id: "weak", label: "pgvector", decisions: ["chose pgvector over qdrant"] }),
    ];
    const store = new InMemoryStore(sessions, [], [
      { sessionId: "strong", score: 20.0 },
      { sessionId: "weak", score: 10.0 }, // 10 * 1.15 = 11.5 < 20.0
    ]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "pgvector qdrant", mode: "keyword" });
    expect(result.results.map((r) => r.id)).toEqual(["strong", "weak"]);
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

  it("hybrid mode uses RRF fusion — rank 1 in both legs scores 2/(60+1)", async () => {
    const store = new InMemoryStore(
      corpus,
      [{ sessionId: "b", distance: 0 }],
      [{ sessionId: "b", score: 9.2 }],
    );
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "pgvector", mode: "hybrid" });
    const top = result.results[0];
    expect(top?.id).toBe("b");
    // RRF with both legs at rank 1, k=60: 1/61 + 1/61 = 2/61 ≈ 0.0328
    expect(top?.matchScore).toBeCloseTo(2 / 61, 4);
    // Informational normalized scores preserved for UI display.
    expect(top?.keywordScore).toBe(1);
    expect(top?.semanticScore).toBe(1);
  });

  it("hybrid RRF: a session in only one leg scores half as much as a session in both legs at the same rank", async () => {
    // Session "a" appears in keyword leg at rank 1.
    // Session "b" appears in BOTH legs at rank 1.
    const store = new InMemoryStore(
      corpus,
      [{ sessionId: "b", distance: 0 }],
      [
        { sessionId: "a", score: 100 }, // huge raw score, but only one leg
        { sessionId: "b", score: 1 },   // tiny raw score, but in both legs
      ],
    );
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "pgvector", mode: "hybrid" });
    expect(result.results[0]?.id).toBe("b"); // both-legs wins despite tiny kw score
    expect(result.results[0]?.matchScore).toBeCloseTo(1 / 61 + 1 / 62, 4); // b is rank 1 sem, rank 2 kw
    expect(result.results[1]?.id).toBe("a");
    expect(result.results[1]?.matchScore).toBeCloseTo(1 / 61, 4); // a is rank 1 kw only
  });

  it("clamps limit to MAX_LIMIT (100) and at least 1", async () => {
    const store = new InMemoryStore(corpus, [], [{ sessionId: "b", score: 5 }]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const big = await svc.search({ query: "session", mode: "keyword", limit: 9999 });
    expect(big.limit).toBe(100);
    const small = await svc.search({ query: "session", mode: "keyword", limit: 0 });
    expect(small.limit).toBe(1);
  });

  it("recency: newer session ranks ahead of equally-scored older session", async () => {
    // Two sessions with the same FTS5 score; one is fresh (multiplier ~1.0),
    // one is two half-lives old (360d → multiplier ~0.25). The newer one
    // must sort first after the recency post-pass in finalize().
    const now = new Date();
    const fresh = makeSession({ id: "fresh", label: "fresh session", startedAt: now.toISOString() });
    const old = makeSession({
      id: "old",
      label: "old session",
      startedAt: new Date(now.getTime() - 360 * 86_400_000).toISOString(),
    });
    const store = new InMemoryStore(
      [fresh, old],
      [],
      // Store returns old first (higher raw score) — finalize must flip them.
      [{ sessionId: "old", score: 10 }, { sessionId: "fresh", score: 10 }],
    );
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "session", mode: "keyword" });
    expect(result.results.map((r) => r.id)).toEqual(["fresh", "old"]);
    expect(result.results[0]!.matchScore).toBeGreaterThan(result.results[1]!.matchScore);
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

  describe("supersedence surfacing (#303)", () => {
    const now = new Date().toISOString();

    it("down-ranks a superseded hit below an equally-matching active one", async () => {
      // Same age, same store score; only difference is status. The superseded
      // hit must sort below the active one after the 0.7 multiplier.
      const sessions: Session[] = [
        makeSession({ id: "sup", label: "pgvector decision", startedAt: now, status: "superseded", supersededBy: "act" }),
        makeSession({ id: "act", label: "pgvector decision", startedAt: now, status: "active" }),
      ];
      const store = new InMemoryStore(sessions, [], [
        { sessionId: "sup", score: 5 },
        { sessionId: "act", score: 5 },
      ]);
      const svc = new RecallService({ store, llm: new StubEmbedder() });
      const result = await svc.search({ query: "pgvector", mode: "keyword", includeSuperseded: true });
      expect(result.results.map((r) => r.id)).toEqual(["act", "sup"]);
      const sup = result.results.find((r) => r.id === "sup")!;
      const act = result.results.find((r) => r.id === "act")!;
      expect(sup.matchScore).toBeLessThan(act.matchScore);
      expect(sup.matchScore).toBeCloseTo(5 * 0.7, 4);
    });

    it("resolves supersededBy to the successor id for superseded hits", async () => {
      const sessions: Session[] = [
        makeSession({ id: "sup", label: "pgvector decision", startedAt: now, status: "superseded", supersededBy: "act" }),
        makeSession({ id: "act", label: "pgvector decision", startedAt: now, status: "active" }),
      ];
      const store = new InMemoryStore(sessions, [], [
        { sessionId: "sup", score: 5 },
        { sessionId: "act", score: 5 },
      ]);
      const svc = new RecallService({ store, llm: new StubEmbedder() });
      const result = await svc.search({ query: "pgvector", mode: "keyword", includeSuperseded: true });
      const sup = result.results.find((r) => r.id === "sup")!;
      const act = result.results.find((r) => r.id === "act")!;
      expect(sup.supersededBy).toBe("act");
      expect(act.supersededBy).toBe(null);
    });

    it("acceptance: the best-matching session is superseded by a weaker successor — surfaced, badged, down-ranked (stranger scenario)", async () => {
      // s2 is the decision session (strongest keyword match) but was overturned
      // by s5 (weaker match). With includeSuperseded, s2 must appear carrying a
      // supersededBy pointer to s5, ranked below s5 despite its stronger raw score.
      const sessions: Session[] = [
        makeSession({
          id: "s2",
          label: "chose pgvector over qdrant pgvector pgvector",
          startedAt: now,
          status: "superseded",
          supersededBy: "s5",
          decisions: ["pgvector over qdrant"],
        }),
        makeSession({
          id: "s5",
          label: "reconsidered: qdrant",
          startedAt: now,
          status: "active",
          decisions: ["moved to qdrant"],
        }),
      ];
      const store = new InMemoryStore(sessions, [], [
        { sessionId: "s2", score: 12 }, // strongest raw match
        { sessionId: "s5", score: 4 },  // weaker successor
      ]);
      const svc = new RecallService({ store, llm: new StubEmbedder() });
      const result = await svc.search({ query: "pgvector qdrant", mode: "keyword", includeSuperseded: true });
      const ids = result.results.map((r) => r.id);
      expect(ids).toContain("s2");
      const s2 = result.results.find((r) => r.id === "s2")!;
      expect(s2.status).toBe("superseded");
      expect(s2.supersededBy).toBe("s5");
      // Score composition: raw BM25 12, superseded down-rank ×0.7, and the
      // #308 metadata tiebreaker. Both query tokens ("pgvector", "qdrant")
      // appear in s2's decision marker ("pgvector over qdrant"), so the
      // decision-overlap fraction is 1.0 → tiebreak ×(1 + 0.13). The
      // down-rank still does not flip this pair (s2 ≫ s5's 4); the badge +
      // successor pointer is what the stranger needed.
      expect(s2.matchScore).toBeCloseTo(12 * 0.7 * 1.13, 4);
    });
  });
});
