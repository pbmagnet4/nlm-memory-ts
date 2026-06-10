/**
 * Spec C integration: prove RecallService routes the rewritten keyword query
 * to the store and fails open back to the raw query when the LLM is
 * unreachable. Uses lightweight stubs — no external services.
 */

import { describe, expect, it } from "vitest";
import { RecallService } from "../../../../src/core/recall/recall-service.js";
import type {
  EmbedResult,
  LLMClient,
  RewriteResult,
} from "../../../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../../../src/ports/llm-client.js";
import type {
  KeywordNeighbor,
  SemanticNeighbor,
  SessionStore,
} from "../../../../src/ports/session-store.js";
import type { Session } from "../../../../src/shared/types.js";
import { makeSession } from "../../../fixtures/sessions.js";

class CapturingStore implements SessionStore {
  keywordSearchCalls: string[] = [];
  constructor(private readonly sessions: Session[]) {}
  async list() {
    return this.sessions;
  }
  async getById(id: string) {
    return this.sessions.find((s) => s.id === id) ?? null;
  }
  async getByIds(ids: ReadonlyArray<string>) {
    return this.sessions.filter((s) => ids.includes(s.id));
  }
  async semanticSearch(): Promise<ReadonlyArray<SemanticNeighbor>> {
    return [];
  }
  async keywordSearch(query: string): Promise<ReadonlyArray<KeywordNeighbor>> {
    this.keywordSearchCalls.push(query);
    return [{ sessionId: this.sessions[0]!.id, score: 5 }];
  }
  async resolveSuccessors(): Promise<Map<string, string>> {
    return new Map();
  }
  async updateStatus() {}
  async markSuperseded() {}
}

class RewritingLLM implements LLMClient {
  rewriteCalls = 0;
  constructor(private readonly result: RewriteResult, private readonly shouldThrow = false) {}
  async embed(): Promise<EmbedResult> {
    return { vector: new Float32Array([1, 0, 0]), model: "stub" };
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
  async rewriteForRecall(): Promise<RewriteResult> {
    this.rewriteCalls += 1;
    if (this.shouldThrow) throw new LLMUnreachableError("test-stub");
    return this.result;
  }
}

const corpus = [makeSession({ id: "a", label: "pgvector migration plan" })];

describe("RecallService rewrite integration (Spec C)", () => {
  it("when rewrite=true, the rewritten keyword query is sent to the store", async () => {
    const store = new CapturingStore(corpus);
    const llm = new RewritingLLM({
      keywordQuery: "pgvector",
      semanticQuery: "pgvector decision",
    });
    const svc = new RecallService({ store, llm });
    await svc.search({ query: "that pgvector thing", mode: "keyword", rewrite: true });
    expect(llm.rewriteCalls).toBe(1);
    expect(store.keywordSearchCalls).toEqual(["pgvector"]);
  });

  it("when rewrite=false, the raw query is sent to the store and no rewrite is called", async () => {
    const store = new CapturingStore(corpus);
    const llm = new RewritingLLM({ keywordQuery: "x", semanticQuery: "x" });
    const svc = new RecallService({ store, llm });
    await svc.search({ query: "raw query", mode: "keyword", rewrite: false });
    expect(llm.rewriteCalls).toBe(0);
    expect(store.keywordSearchCalls).toEqual(["raw query"]);
  });

  it("when rewrite flag is unset, defaults to off (no LLM call, raw query used)", async () => {
    const store = new CapturingStore(corpus);
    const llm = new RewritingLLM({ keywordQuery: "x", semanticQuery: "x" });
    const svc = new RecallService({ store, llm });
    await svc.search({ query: "raw query", mode: "keyword" });
    expect(llm.rewriteCalls).toBe(0);
    expect(store.keywordSearchCalls).toEqual(["raw query"]);
  });

  it("fails open when the LLM is unreachable — raw query used downstream", async () => {
    const store = new CapturingStore(corpus);
    const llm = new RewritingLLM({ keywordQuery: "x", semanticQuery: "x" }, true);
    const svc = new RecallService({ store, llm });
    const result = await svc.search({
      query: "that pgvector thing",
      mode: "keyword",
      rewrite: true,
    });
    expect(llm.rewriteCalls).toBe(1);
    expect(store.keywordSearchCalls).toEqual(["that pgvector thing"]);
    // Search still succeeded — fail-open did not block the response.
    expect(result.total).toBeGreaterThan(0);
  });

  it("caches the rewrite — repeat call within TTL hits the cache, not the LLM", async () => {
    const store = new CapturingStore(corpus);
    const llm = new RewritingLLM({ keywordQuery: "pgvector", semanticQuery: "pgvector" });
    const svc = new RecallService({ store, llm });
    await svc.search({ query: "that pgvector thing", mode: "keyword", rewrite: true });
    await svc.search({ query: "that pgvector thing", mode: "keyword", rewrite: true });
    expect(llm.rewriteCalls).toBe(1); // second call hit the cache
    expect(store.keywordSearchCalls).toEqual(["pgvector", "pgvector"]);
  });
});
