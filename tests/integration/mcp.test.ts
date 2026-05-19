/**
 * MCP adapter integration. Exercises the tool handlers directly (no stdio
 * transport) to prove the in-process binding to RecallService + SessionStore
 * works end-to-end.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import {
  getSessionHandler,
  recallSessionsHandler,
  createMcpServer,
} from "../../src/mcp/server.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { Session } from "../../src/shared/types.js";
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
      entities: ["NLE Memory"],
      decisions: ["chose Hono"],
    }),
    embedding: unit([1, 0, 0]),
  },
  {
    session: makeSession({
      id: "sess_b",
      label: "pgvector migration plan",
      entities: ["NLE Memory", "Postgres"],
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
    tmp = mkdtempSync(join(tmpdir(), "nle-mcp-"));
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

  it("recall_sessions defaults to keyword mode + 10-item limit", async () => {
    const result = await recallSessionsHandler({ recall, store }, { query: "hono" });
    const body = parsePayload(result) as { mode: string; limit: number };
    expect(body.mode).toBe("keyword");
    expect(body.limit).toBe(10);
  });

  it("recall_sessions threads entity + kind filters into RecallService", async () => {
    const result = await recallSessionsHandler(
      { recall, store },
      { query: "pgvector", entity: "NLE Memory", kind: "open" },
    );
    const body = parsePayload(result) as {
      entity: string;
      kind: string;
      results: { id: string }[];
    };
    expect(body.entity).toBe("NLE Memory");
    expect(body.kind).toBe("open");
    expect(body.results.every((r) => r.id === "sess_b")).toBe(true);
  });

  it("get_session returns the full session for a known id", async () => {
    const result = await getSessionHandler({ recall, store }, { id: "sess_a" });
    expect(result.isError).toBeUndefined();
    const body = parsePayload(result) as { id: string; entities: string[] };
    expect(body.id).toBe("sess_a");
    expect(body.entities).toContain("NLE Memory");
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
});
