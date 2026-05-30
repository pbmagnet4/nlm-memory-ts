/**
 * MCP adapter integration. Exercises the tool handlers directly (no stdio
 * transport) to prove the in-process binding to RecallService + SessionStore
 * works end-to-end.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactRecallService } from "../../src/core/recall-facts/fact-recall-service.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import {
  createMcpServer,
  getFactHistoryHandler,
  getSessionHandler,
  markSupersededHandler,
  recallFactsHandler,
  recallSessionsHandler,
} from "../../src/mcp/server.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { Session } from "../../src/shared/types.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function unit(values: number[]): Float32Array {
  const padded = new Float32Array(768);
  values.forEach((v, i) => {
    padded[i] = v;
  });
  let sum = 0;
  for (const v of padded) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < padded.length; i++) padded[i] = (padded[i] ?? 0) / norm;
  return padded;
}

class FixedEmbedder implements LLMClient {
  constructor(private readonly vector: Float32Array) {}
  async embed(): Promise<EmbedResult> {
    return { vector: this.vector, model: "fixed-test" };
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

const seed: ReadonlyArray<{ session: Session; embedding: Float32Array }> = [
  {
    session: makeSession({
      id: "sess_a",
      label: "Hono router setup",
      entities: ["NLM"],
      decisions: ["chose Hono"],
    }),
    embedding: unit([1, 0, 0]),
  },
  {
    session: makeSession({
      id: "sess_b",
      label: "pgvector migration plan",
      entities: ["NLM", "Postgres"],
      open: ["cutover timing"],
    }),
    embedding: unit([0, 1, 0]),
  },
];

interface ParsedTool {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function parsePayload(result: ParsedTool): unknown {
  const first = result.content[0];
  if (!first) throw new Error("empty tool result");
  return JSON.parse(first.text);
}

describe("MCP adapter", () => {
  let tmp: string;
  let store: SqliteSessionStore;
  let recall: RecallService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-mcp-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    for (const { session, embedding } of seed) {
      store.insertSessionForTest(session);
      store.insertEmbeddingForTest(session.id, embedding);
    }
    recall = new RecallService({
      store,
      llm: new FixedEmbedder(unit([0, 1, 0])),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("recall_sessions returns the keyword hit", async () => {
    const result = await recallSessionsHandler(
      { recall, store },
      { query: "pgvector", mode: "keyword" },
    );
    expect(result.isError).toBeUndefined();
    const body = parsePayload(result) as { total: number; results: { id: string }[] };
    expect(body.total).toBe(1);
    expect(body.results[0]?.id).toBe("sess_b");
  });

  it("recall_sessions defaults to hybrid mode + 10-item limit", async () => {
    const result = await recallSessionsHandler({ recall, store }, { query: "hono" });
    const body = parsePayload(result) as { mode: string; limit: number };
    expect(body.mode).toBe("hybrid");
    expect(body.limit).toBe(10);
  });

  it("recall_sessions threads entity + kind filters into RecallService", async () => {
    const result = await recallSessionsHandler(
      { recall, store },
      { query: "pgvector", entity: "NLM", kind: "open" },
    );
    const body = parsePayload(result) as {
      entity: string;
      kind: string;
      results: { id: string }[];
    };
    expect(body.entity).toBe("NLM");
    expect(body.kind).toBe("open");
    expect(body.results.every((r) => r.id === "sess_b")).toBe(true);
  });

  it("get_session returns the full session for a known id", async () => {
    const result = await getSessionHandler({ recall, store }, { id: "sess_a" });
    expect(result.isError).toBeUndefined();
    const body = parsePayload(result) as { id: string; entities: string[] };
    expect(body.id).toBe("sess_a");
    expect(body.entities).toContain("NLM");
  });

  it("get_session includes supersedence links when an edge exists", async () => {
    store.insertEdgeForTest("sess_a", "sess_b", "supersedes");
    const newer = await getSessionHandler({ recall, store }, { id: "sess_a" });
    const older = await getSessionHandler({ recall, store }, { id: "sess_b" });
    type SupersedesEntry = { id: string; label: string; summary: string };
    type SupersededBy = { id: string; label: string; summary: string } | null;
    const newerBody = parsePayload(newer) as { supersedes: SupersedesEntry[]; supersededBy: SupersededBy };
    const olderBody = parsePayload(older) as { supersedes: SupersedesEntry[]; supersededBy: SupersededBy };
    expect(newerBody.supersedes).toHaveLength(1);
    expect(newerBody.supersedes[0]!.id).toBe("sess_b");
    expect(typeof newerBody.supersedes[0]!.label).toBe("string");
    expect(newerBody.supersededBy).toBeNull();
    expect(olderBody.supersededBy).not.toBeNull();
    expect(olderBody.supersededBy!.id).toBe("sess_a");
    expect(typeof olderBody.supersededBy!.label).toBe("string");
    expect(olderBody.supersedes).toEqual([]);
  });

  it("get_session returns an error tool result on missing id", async () => {
    const result = await getSessionHandler(
      { recall, store },
      { id: "does_not_exist" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not found");
  });

  it("createMcpServer registers both tools without throwing", () => {
    const server = createMcpServer({ recall, store });
    expect(server).toBeDefined();
  });

  describe("mark_superseded", () => {
    beforeEach(() => {
      // isolate the supersedence log to a temp path so the host log isn't touched
      process.env["NLM_SUPERSEDENCE_LOG"] = join(tmp, "supersedence-log.jsonl");
    });
    afterEach(() => {
      delete process.env["NLM_SUPERSEDENCE_LOG"];
    });

    it("flips predecessor status and inserts a supersedes edge", async () => {
      const result = await markSupersededHandler(
        { recall, store },
        { predecessor_id: "sess_a", successor_id: "sess_b", reason: "newer plan replaces it" },
      );
      expect(result.isError).toBeUndefined();
      const body = parsePayload(result) as { marked: boolean; predecessor_id: string };
      expect(body.marked).toBe(true);
      expect(body.predecessor_id).toBe("sess_a");

      // get_session on the predecessor now shows supersededBy linked to sess_b
      const older = await getSessionHandler({ recall, store }, { id: "sess_a" });
      const olderBody = parsePayload(older) as {
        status: string;
        supersededBy: { id: string } | null;
      };
      expect(olderBody.status).toBe("superseded");
      expect(olderBody.supersededBy?.id).toBe("sess_b");
    });

    it("is idempotent — re-marking the same pair stays clean", async () => {
      await markSupersededHandler(
        { recall, store },
        { predecessor_id: "sess_a", successor_id: "sess_b" },
      );
      const second = await markSupersededHandler(
        { recall, store },
        { predecessor_id: "sess_a", successor_id: "sess_b" },
      );
      expect(second.isError).toBeUndefined();

      // sess_b now reports exactly one supersedes link, not two
      const newer = await getSessionHandler({ recall, store }, { id: "sess_b" });
      const newerBody = parsePayload(newer) as { supersedes: { id: string }[] };
      expect(newerBody.supersedes).toHaveLength(1);
    });

    it("errors when predecessor id is unknown", async () => {
      const result = await markSupersededHandler(
        { recall, store },
        { predecessor_id: "ghost", successor_id: "sess_b" },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("predecessor");
    });

    it("errors when successor id is unknown", async () => {
      const result = await markSupersededHandler(
        { recall, store },
        { predecessor_id: "sess_a", successor_id: "ghost" },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("successor");
    });

    it("errors when predecessor equals successor", async () => {
      const result = await markSupersededHandler(
        { recall, store },
        { predecessor_id: "sess_a", successor_id: "sess_a" },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("itself");
    });
  });

  describe("fact tools (B.3)", () => {
    let factStore: SqliteFactStore;
    let factRecall: FactRecallService;

    beforeEach(async () => {
      factStore = new SqliteFactStore(store.rawDb());
      factRecall = new FactRecallService({
        factStore,
        llm: new FixedEmbedder(unit([1, 0, 0])),
      });
      await factStore.insertMany([
        makeFact({
          id: "f_hono",
          subject: "nlm-memory-ts",
          predicate: "framework",
          value: "Hono",
          confidence: 0.9,
          sourceSessionId: "sess_a",
        }),
        makeFact({
          id: "f_endpoint",
          kind: "attribute",
          subject: "mac-pro-llm-host",
          predicate: "endpoint",
          value: "http://macpro:8080/v1",
          confidence: 0.85,
          sourceSessionId: "sess_b",
        }),
      ]);
    });

    it("recall_facts returns the current fact for an exact subject+predicate", async () => {
      const result = await recallFactsHandler(
        { recall, store, factRecall, factStore },
        { subject: "nlm-memory-ts", predicate: "framework" },
      );
      expect(result.isError).toBeUndefined();
      const body = parsePayload(result) as {
        total: number;
        results: { id: string; value: string }[];
      };
      expect(body.total).toBe(1);
      expect(body.results[0]?.id).toBe("f_hono");
      expect(body.results[0]?.value).toBe("Hono");
    });

    it("recall_facts returns an error tool result when factRecall is missing", async () => {
      const result = await recallFactsHandler(
        { recall, store },
        { subject: "x" },
      );
      expect(result.isError).toBe(true);
    });

    it("get_fact_history returns chains ordered newest → oldest", async () => {
      await factStore.insertMany([
        makeFact({
          id: "f_old",
          subject: "nlm-memory-ts",
          predicate: "framework",
          value: "Fastify",
          createdAt: "2026-05-18T00:00:00Z",
          confidence: 0.9,
          sourceSessionId: "sess_a",
        }),
      ]);
      await factStore.markSuperseded("f_old", "f_hono");

      const result = await getFactHistoryHandler(
        { recall, store, factRecall, factStore },
        { subject: "nlm-memory-ts", predicate: "framework" },
      );
      const body = parsePayload(result) as {
        chains: { history: { id: string }[] }[];
      };
      expect(body.chains).toHaveLength(1);
      expect(body.chains[0]?.history.map((f) => f.id)).toEqual(["f_hono", "f_old"]);
    });

    it("createMcpServer registers fact tools when factRecall + factStore wired", () => {
      const server = createMcpServer({ recall, store, factRecall, factStore });
      expect(server).toBeDefined();
    });
  });
});
