/**
 * Integration tests for the Phase D Scheduler. Drives a tick against a
 * fixture-backed adapter through real SqliteSessionStore + sqlite-vec,
 * with fake LLMClients standing in for classifier and embedder.
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { ClaudeCodeAdapter } from "../../src/core/adapters/claude-code.js";
import { ScanScheduler } from "../../src/core/scheduler/scheduler.js";
import type {
  ClassifyResult,
  EmbedResult,
  LLMClient,
} from "../../src/ports/llm-client.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const FIXTURES = resolve(__dirname, "../fixtures/claude_code");

function ageFiles(dir: string, ageMs: number): void {
  const now = (Date.now() - ageMs) / 1000;
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) ageFiles(full, ageMs);
    else if (statSync(full).isFile()) utimesSync(full, now, now);
  }
}

class StubClassifier implements LLMClient {
  calls = 0;
  constructor(
    private readonly result: ClassifyResult = {
      label: "Stub label",
      summary: "Stub summary",
      entities: ["NLM"],
      decisions: ["chose Hono"],
      open: [],
      confidence: 0.9,
      facts: [],
    },
    private readonly throwError: boolean = false,
  ) {}
  async embed(): Promise<EmbedResult> {
    throw new Error("not used");
  }
  async classify(): Promise<ClassifyResult> {
    this.calls += 1;
    if (this.throwError) throw new Error("classifier blew up");
    return this.result;
  }
}

class StubEmbedder implements LLMClient {
  calls = 0;
  async embed(): Promise<EmbedResult> {
    this.calls += 1;
    const v = new Float32Array(768);
    v[0] = 1;
    return { vector: v, model: "stub" };
  }
  async classify(): Promise<ClassifyResult> {
    throw new Error("not used");
  }
}

describe("ScanScheduler.tick", () => {
  let tmp: string;
  let dbPath: string;
  let projects: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-sched-"));
    dbPath = join(tmp, "canonical.sqlite");
    projects = join(tmp, "projects");
    mkdirSync(join(projects, "project_a"), { recursive: true });
    copyFileSync(
      join(FIXTURES, "standard_iso.jsonl"),
      join(projects, "project_a", "fixture.jsonl"),
    );
    // make it look idle so scanOnce picks it up
    ageFiles(projects, 60 * 60 * 1000);
    store = new SqliteSessionStore({ dbPath, migrationsDir: MIGRATIONS_DIR });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ingests a discovered chunk: row + markers + entity link + embedding + adapter_state", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier();
    const embedder = new StubEmbedder();
    const scheduler = new ScanScheduler({
      store,
      adapters: [adapter],
      classifier,
      embedder,
      logger: () => {},
    });

    const report = await scheduler.tick();
    expect(report.chunksSeen).toBe(1);
    expect(report.inserted).toBe(1);
    expect(report.skippedLowConfidence).toBe(0);
    expect(classifier.calls).toBe(1);
    expect(embedder.calls).toBe(1);

    const db = new Database(dbPath);
    sqliteVec.load(db);
    const sess = db.prepare<[], { id: string; label: string; status: string }>(
      "SELECT id, label, status FROM sessions",
    ).all();
    expect(sess).toHaveLength(1);
    expect(sess[0]?.label).toBe("Stub label");
    expect(sess[0]?.status).toBe("closed");

    const markers = db.prepare<[string], { kind: string; text: string }>(
      "SELECT kind, text FROM markers WHERE session_id = ?",
    ).all(sess[0]!.id);
    expect(markers.find((m) => m.kind === "decision")?.text).toBe("chose Hono");

    const ent = db.prepare<[string], { entity_canonical: string }>(
      "SELECT entity_canonical FROM session_entities WHERE session_id = ?",
    ).all(sess[0]!.id);
    expect(ent[0]?.entity_canonical).toBe("NLM");

    const emb = db.prepare<[string], { c: number }>(
      "SELECT COUNT(*) AS c FROM session_chunk_map WHERE session_id = ?",
    ).get(sess[0]!.id);
    expect(emb?.c).toBeGreaterThanOrEqual(1);

    const state = db.prepare<[], { source_path: string; session_id: string }>(
      "SELECT source_path, session_id FROM adapter_state WHERE adapter_name = 'claude-code'",
    ).all();
    expect(state).toHaveLength(1);
    expect(state[0]?.session_id).toBe(sess[0]!.id);
    db.close();
  });

  it("a second tick is a no-op when the file is unchanged", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier();
    const embedder = new StubEmbedder();
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder, logger: () => {},
    });

    await scheduler.tick();
    const report = await scheduler.tick();
    expect(report.chunksSeen).toBe(0);
    expect(report.inserted).toBe(0);
  });

  it("skips chunks below the confidence floor", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier({
      label: "x", summary: "y", entities: [], decisions: [], open: [], confidence: 0.1, facts: [],
    });
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, logger: () => {},
    });
    const report = await scheduler.tick();
    expect(report.skippedLowConfidence).toBe(1);
    expect(report.inserted).toBe(0);
  });

  it("classifier failure is contained — chunk skipped, ingest continues", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier(undefined, true);
    const messages: string[] = [];
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null,
      logger: (m) => messages.push(m),
    });
    const report = await scheduler.tick();
    expect(report.classifyFailures).toBe(1);
    expect(report.inserted).toBe(0);
    expect(messages.some((m) => m.includes("classifier"))).toBe(true);
  });

  it("supersedence wires the edge + flips prior status when a file grows", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier();
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, logger: () => {},
    });
    const firstReport = await scheduler.tick();
    expect(firstReport.inserted).toBe(1);
    const firstId = store.rawDb()
      .prepare<[], { session_id: string }>(
        "SELECT session_id FROM adapter_state WHERE adapter_name = 'claude-code'",
      ).get()!.session_id;

    // Append + age + change runtime_session_id so the parser yields a new id
    const fixturePath = join(projects, "project_a", "fixture.jsonl");
    const { readFileSync, writeFileSync, utimesSync } = require("node:fs") as typeof import("node:fs");
    const original = readFileSync(fixturePath, "utf8");
    const mutated = original
      .replace(/"sessionId"\s*:\s*"[^"]+"/g, '"sessionId": "resumed-uuid-12345"') +
      JSON.stringify({ type: "user", message: { content: "more work" }, timestamp: "2026-05-19T11:00:00Z" }) + "\n";
    writeFileSync(fixturePath, mutated);
    const oldT = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(fixturePath, oldT, oldT);

    const secondReport = await scheduler.tick();
    expect(secondReport.inserted).toBe(1);

    const db = store.rawDb();
    const edges = db.prepare<[], { from_session: string; to_session: string; kind: string }>(
      "SELECT from_session, to_session, kind FROM session_edges",
    ).all();
    expect(edges).toHaveLength(1);
    expect(edges[0]?.kind).toBe("supersedes");
    expect(edges[0]?.to_session).toBe(firstId);

    const supersededStatus = db.prepare<[string], { status: string }>(
      "SELECT status FROM sessions WHERE id = ?",
    ).get(firstId);
    expect(supersededStatus?.status).toBe("superseded");
  });

  it("re-ingest of the same session updates row in place (no duplicates)", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier();
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, logger: () => {},
    });
    await scheduler.tick();
    // Reset adapter_state to force re-ingest of the same file
    store.rawDb().prepare("DELETE FROM adapter_state").run();
    const second = await scheduler.tick();
    expect(second.inserted).toBe(1);
    const count = store.rawDb()
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM sessions").get();
    expect(count?.c).toBe(1);
  });

  it("writes facts atomically with the session row when a FactStore is configured (B.2)", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier({
      label: "Stub label",
      summary: "Stub summary",
      entities: ["NLM"],
      decisions: ["chose Hono"],
      open: [],
      confidence: 0.9,
      facts: [
        { kind: "decision", subject: "nlm-memory-ts", predicate: "framework", value: "Hono" },
        {
          kind: "attribute",
          subject: "mac-pro-llm-host",
          predicate: "endpoint",
          value: "http://macpro:8080/v1",
        },
      ],
    });
    const factStore = new SqliteFactStore(store.rawDb());
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, factStore, logger: () => {},
    });
    const report = await scheduler.tick();
    expect(report.inserted).toBe(1);

    const sessId = store.rawDb()
      .prepare<[], { session_id: string }>(
        "SELECT session_id FROM adapter_state WHERE adapter_name = 'claude-code'",
      ).get()!.session_id;
    const facts = await factStore.listBySession(sessId);
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => `${f.subject}:${f.predicate}:${f.value}`).sort()).toEqual([
      "mac-pro-llm-host:endpoint:http://macpro:8080/v1",
      "nlm-memory-ts:framework:Hono",
    ]);
    for (const f of facts) {
      expect(f.sourceSessionId).toBe(sessId);
      expect(f.confidence).toBe(0.9);
      expect(f.supersededBy).toBeNull();
    }
  });

  it("does not write facts when FactStore is not provided (backwards compat)", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier({
      label: "L", summary: "S", entities: [], decisions: [], open: [], confidence: 0.9,
      facts: [{ kind: "decision", subject: "x", predicate: "framework", value: "y" }],
    });
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, logger: () => {},
    });
    await scheduler.tick();
    const count = store.rawDb()
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM facts").get();
    expect(count?.c).toBe(0);
  });

  it("writes fact embeddings when both FactStore and embedder are configured (B.3)", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier({
      label: "L", summary: "S", entities: [], decisions: [], open: [], confidence: 0.9,
      facts: [
        { kind: "decision", subject: "nlm-memory-ts", predicate: "framework", value: "Hono" },
        { kind: "attribute", subject: "mac-pro", predicate: "endpoint", value: "http://macpro:8080/v1" },
      ],
    });
    const embedder = new StubEmbedder();
    const factStore = new SqliteFactStore(store.rawDb());
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder, factStore, logger: () => {},
    });
    await scheduler.tick();
    // session embedding (1) + per-fact embeddings (2) = 3 calls
    expect(embedder.calls).toBe(3);
    const count = store.rawDb()
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM fact_embeddings").get();
    expect(count?.c).toBe(2);
  });

  it("re-ingest replaces facts (no duplicate fact rows across ticks)", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier({
      label: "L", summary: "S", entities: [], decisions: [], open: [], confidence: 0.9,
      facts: [{ kind: "decision", subject: "nlm-memory-ts", predicate: "framework", value: "Hono" }],
    });
    const factStore = new SqliteFactStore(store.rawDb());
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, factStore, logger: () => {},
    });
    await scheduler.tick();
    store.rawDb().prepare("DELETE FROM adapter_state").run();
    await scheduler.tick();

    const count = store.rawDb()
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM facts").get();
    expect(count?.c).toBe(1);
  });
});
