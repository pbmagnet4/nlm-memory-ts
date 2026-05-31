/**
 * Phase B.5 — backfillFacts integration. Seeds a real SQLite store with
 * sessions that have no facts, runs the backfill module against a stub
 * classifier, and verifies facts land + supersedence fires + state file
 * resumes correctly.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillFacts } from "../../src/core/facts/backfill-facts.js";
import type { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type {
  ClassifyResult,
  EmbedResult,
  ExtractedFact,
  LLMClient,
} from "../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

class ScriptedClassifier implements LLMClient {
  calls: string[] = [];
  constructor(
    private readonly results: Map<string, ClassifyResult>,
    private readonly errorIds: Set<string> = new Set(),
  ) {}
  async embed(): Promise<EmbedResult> {
    throw new Error("not used");
  }
  async classify(transcript: string): Promise<ClassifyResult> {
    this.calls.push(transcript);
    if (this.errorIds.has(transcript)) {
      throw new LLMUnreachableError("test-stub");
    }
    const result = this.results.get(transcript);
    if (!result) throw new Error(`no scripted result for transcript: ${transcript.slice(0, 60)}`);
    return result;
  }
}

function classifyResult(
  facts: ExtractedFact[],
  confidence = 0.9,
): ClassifyResult {
  return {
    label: "L",
    summary: "S",
    entities: [],
    decisions: [],
    open: [],
    confidence,
    facts,
  };
}

describe("backfillFacts", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  let factStore: SqliteFactStore;
  let statePath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-b5-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
    factStore = storage.facts;
    statePath = join(tmp, "backfill_facts.state");
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes facts for sessions that have none, skips sessions with existing facts", async () => {
    // Two sessions need backfill; one already has a fact.
    store.insertSessionForTest(makeSession({
      id: "sess_old1", body: "BODY-OLD-1", startedAt: "2026-05-17T10:00:00Z",
    }));
    store.insertSessionForTest(makeSession({
      id: "sess_old2", body: "BODY-OLD-2", startedAt: "2026-05-17T11:00:00Z",
    }));
    store.insertSessionForTest(makeSession({
      id: "sess_done", body: "BODY-DONE", startedAt: "2026-05-17T12:00:00Z",
    }));
    // Pre-existing fact on sess_done — backfill should skip it.
    await factStore.insert({
      id: "f_pre", kind: "decision", subject: "x", predicate: "framework",
      value: "v", sourceSessionId: "sess_done", sourceQuote: null,
      createdAt: "2026-05-17T12:00:00Z", supersededBy: null, confidence: 0.9,
    });

    const classifier = new ScriptedClassifier(new Map([
      ["BODY-OLD-1", classifyResult([
        { kind: "decision", subject: "nlm-memory-ts", predicate: "framework", value: "Hono" },
      ])],
      ["BODY-OLD-2", classifyResult([
        { kind: "attribute", subject: "mac-pro", predicate: "endpoint", value: ":8080" },
        { kind: "attribute", subject: "mac-pro", predicate: "model", value: "qwen2.5-3b" },
      ])],
    ]));

    const report = await backfillFacts({
      store, factStore, classifier, statePath,
    });

    expect(report.total).toBe(2); // sess_done excluded by the NOT EXISTS clause
    expect(report.processed).toBe(2);
    expect(report.factsWritten).toBe(3);
    expect(classifier.calls).toHaveLength(2);

    expect(await factStore.listBySession("sess_old1")).toHaveLength(1);
    expect(await factStore.listBySession("sess_old2")).toHaveLength(2);
    expect(await factStore.listBySession("sess_done")).toHaveLength(1); // untouched
  });

  it("supersedence fires across backfill iterations (B.4 in the backfill path)", async () => {
    // Two sessions, both assert framework= for the same subject — newer wins.
    store.insertSessionForTest(makeSession({
      id: "sess_early", body: "BODY-EARLY", startedAt: "2026-05-17T10:00:00Z",
    }));
    store.insertSessionForTest(makeSession({
      id: "sess_late", body: "BODY-LATE", startedAt: "2026-05-18T10:00:00Z",
    }));
    const classifier = new ScriptedClassifier(new Map([
      ["BODY-EARLY", classifyResult([
        { kind: "decision", subject: "x", predicate: "framework", value: "Fastify" },
      ])],
      ["BODY-LATE", classifyResult([
        { kind: "decision", subject: "x", predicate: "framework", value: "Hono" },
      ])],
    ]));

    await backfillFacts({ store, factStore, classifier, statePath });

    const current = await factStore.findCurrent("x", "framework");
    expect(current?.value).toBe("Hono");
    expect(current?.sourceSessionId).toBe("sess_late");

    const chains = await factStore.getHistory("x", "framework");
    expect(chains[0]?.history.map((f) => f.value)).toEqual(["Hono", "Fastify"]);
  });

  it("dry-run reports counts without writing", async () => {
    store.insertSessionForTest(makeSession({
      id: "sess_dry", body: "BODY-DRY", startedAt: "2026-05-17T10:00:00Z",
    }));
    const classifier = new ScriptedClassifier(new Map([
      ["BODY-DRY", classifyResult([
        { kind: "decision", subject: "x", predicate: "framework", value: "v" },
      ])],
    ]));

    const report = await backfillFacts({
      store, factStore, classifier, statePath, dryRun: true,
    });

    expect(report.processed).toBe(1);
    expect(report.factsWritten).toBe(1);
    expect(await factStore.listBySession("sess_dry")).toHaveLength(0); // not written
    expect(existsSync(statePath)).toBe(false); // dry-run never touches state
  });

  it("state file is written after the run and used to skip done ids on reprocess re-runs", async () => {
    store.insertSessionForTest(makeSession({
      id: "sess_a", body: "BODY-A", startedAt: "2026-05-17T10:00:00Z",
    }));
    store.insertSessionForTest(makeSession({
      id: "sess_b", body: "BODY-B", startedAt: "2026-05-17T11:00:00Z",
    }));
    const classifier = new ScriptedClassifier(new Map([
      ["BODY-A", classifyResult([
        { kind: "decision", subject: "x", predicate: "framework", value: "v" },
      ])],
      ["BODY-B", classifyResult([
        { kind: "decision", subject: "y", predicate: "framework", value: "v" },
      ])],
    ]));

    const r1 = await backfillFacts({ store, factStore, classifier, statePath });
    expect(r1.processed).toBe(2);
    expect(JSON.parse(readFileSync(statePath, "utf8")).done.sort()).toEqual([
      "sess_a", "sess_b",
    ]);

    // Without reprocess, the SQL eligibility filter excludes both — the
    // happy-path "resume" is implicit (rows already have facts).
    const r2 = await backfillFacts({
      store, factStore, classifier: new ScriptedClassifier(new Map()), statePath,
    });
    expect(r2.total).toBe(0);

    // With reprocess, eligibility drops the NOT-EXISTS clause; the state
    // file is what keeps a resumed run from re-classifying done ids. Under
    // the post-fix semantics, state-file ids are filtered out BEFORE the
    // work queue is built, so `total` is 0 (empty work queue) and
    // `skippedAlreadyDone` reports the pre-filter count.
    const r3 = await backfillFacts({
      store, factStore, classifier: new ScriptedClassifier(new Map()), statePath,
      reprocess: true,
    });
    expect(r3.total).toBe(0);
    expect(r3.skippedAlreadyDone).toBe(2);
    expect(r3.processed).toBe(0);
  });

  it("--from skips sessions with id <= cutoff", async () => {
    store.insertSessionForTest(makeSession({
      id: "sess_aaa", body: "BODY-A", startedAt: "2026-05-17T10:00:00Z",
    }));
    store.insertSessionForTest(makeSession({
      id: "sess_zzz", body: "BODY-Z", startedAt: "2026-05-17T11:00:00Z",
    }));
    const classifier = new ScriptedClassifier(new Map([
      ["BODY-Z", classifyResult([
        { kind: "decision", subject: "z", predicate: "framework", value: "v" },
      ])],
    ]));
    const report = await backfillFacts({
      store, factStore, classifier, statePath, from: "sess_aaa",
    });
    expect(report.total).toBe(1);
    expect(classifier.calls).toEqual(["BODY-Z"]);
  });

  it("limit caps the batch size", async () => {
    for (let i = 0; i < 5; i++) {
      store.insertSessionForTest(makeSession({
        id: `sess_${i}`, body: `BODY-${i}`, startedAt: `2026-05-17T10:0${i}:00Z`,
      }));
    }
    const map = new Map<string, ClassifyResult>();
    for (let i = 0; i < 5; i++) {
      map.set(`BODY-${i}`, classifyResult([
        { kind: "decision", subject: `s${i}`, predicate: "framework", value: "v" },
      ]));
    }
    const classifier = new ScriptedClassifier(map);
    const report = await backfillFacts({
      store, factStore, classifier, statePath, limit: 2,
    });
    expect(report.total).toBe(2);
    expect(report.processed).toBe(2);
    expect(classifier.calls).toHaveLength(2);
  });

  it("limit counts processable sessions, not raw SQL rows (filters state-file done BEFORE limit)", async () => {
    // 5 sessions in the corpus. 3 are already done in the state file (e.g.
    // previously hit low-confidence). With --limit 2, the OLD behavior would
    // slice the first 2 SQL rows (both done) and process 0; the NEW behavior
    // filters out the 3 done ids and then processes the next 2 untouched
    // sessions — actually doing 2 sessions worth of work as the operator
    // expects.
    for (let i = 0; i < 5; i++) {
      store.insertSessionForTest(makeSession({
        id: `sess_${i}`, body: `BODY-${i}`, startedAt: `2026-05-17T10:0${i}:00Z`,
      }));
    }
    // Pre-populate state file as if sess_0, sess_1, sess_2 already done
    // (e.g. via prior low-confidence runs).
    const fs = await import("node:fs");
    fs.writeFileSync(statePath, JSON.stringify({ done: ["sess_0", "sess_1", "sess_2"] }));

    const classifier = new ScriptedClassifier(new Map([
      ["BODY-3", classifyResult([
        { kind: "decision", subject: "s3", predicate: "framework", value: "v" },
      ])],
      ["BODY-4", classifyResult([
        { kind: "decision", subject: "s4", predicate: "framework", value: "v" },
      ])],
    ]));
    const report = await backfillFacts({
      store, factStore, classifier, statePath, limit: 2,
    });
    expect(report.skippedAlreadyDone).toBe(3); // pre-filter count
    expect(report.total).toBe(2);              // work queue after pre-filter
    expect(report.processed).toBe(2);          // both processed
    expect(classifier.calls.sort()).toEqual(["BODY-3", "BODY-4"]);
  });

  it("low-confidence sessions get marked done so a re-run doesn't re-classify them", async () => {
    store.insertSessionForTest(makeSession({
      id: "sess_low", body: "BODY-LOW", startedAt: "2026-05-17T10:00:00Z",
    }));
    const classifier = new ScriptedClassifier(new Map([
      ["BODY-LOW", classifyResult(
        [{ kind: "decision", subject: "x", predicate: "framework", value: "v" }],
        0.2,
      )],
    ]));
    const r1 = await backfillFacts({ store, factStore, classifier, statePath });
    expect(r1.skippedLowConfidence).toBe(1);
    expect(r1.factsWritten).toBe(0);

    // Re-run uses the state file to skip rather than retrying.
    const r2 = await backfillFacts({
      store, factStore, classifier: new ScriptedClassifier(new Map()), statePath,
    });
    expect(r2.skippedAlreadyDone).toBe(1);
  });

  it("stops the whole run when classifier reports LLMUnreachable (don't burn API)", async () => {
    for (let i = 0; i < 3; i++) {
      store.insertSessionForTest(makeSession({
        id: `sess_${i}`, body: `BODY-${i}`, startedAt: `2026-05-17T10:0${i}:00Z`,
      }));
    }
    const classifier = new ScriptedClassifier(
      new Map(),
      new Set(["BODY-0"]), // first session immediately errors
    );
    const report = await backfillFacts({ store, factStore, classifier, statePath });
    expect(report.classifyFailures).toBe(1);
    expect(report.processed).toBe(0);
    // Should NOT call the classifier on the remaining 2 sessions.
    expect(classifier.calls).toEqual(["BODY-0"]);
  });

  it("excludes sessions started at or after the script's cutoff (race with live ingest)", async () => {
    // Insert a session with a startedAt in the future relative to NOW.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    store.insertSessionForTest(makeSession({
      id: "sess_future", body: "BODY-FUTURE", startedAt: future,
    }));
    const classifier = new ScriptedClassifier(new Map());
    const report = await backfillFacts({ store, factStore, classifier, statePath });
    expect(report.total).toBe(0);
  });

  it("reprocess=true re-classifies sessions that already have facts", async () => {
    store.insertSessionForTest(makeSession({
      id: "sess_repro", body: "BODY-REPRO", startedAt: "2026-05-17T10:00:00Z",
    }));
    await factStore.insert({
      id: "f_existing", kind: "decision", subject: "x", predicate: "framework",
      value: "old", sourceSessionId: "sess_repro", sourceQuote: null,
      createdAt: "2026-05-17T10:00:00Z", supersededBy: null, confidence: 0.9,
    });

    const classifier = new ScriptedClassifier(new Map([
      ["BODY-REPRO", classifyResult([
        { kind: "decision", subject: "x", predicate: "framework", value: "new" },
      ])],
    ]));
    const report = await backfillFacts({
      store, factStore, classifier, statePath, reprocess: true,
    });
    expect(report.processed).toBe(1);

    // The DELETE+insert pattern in ingestSessionFacts wipes the old
    // fact (same source_session_id) and writes the new one.
    const all = await factStore.listBySession("sess_repro");
    expect(all.map((f) => f.value)).toEqual(["new"]);
  });
});
