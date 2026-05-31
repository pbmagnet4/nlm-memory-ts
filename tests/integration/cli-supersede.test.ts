/**
 * CLI executeSupersede() tests. Drives the pure-function entry point with
 * a stub IO so we can exercise every branch — happy path, idempotent
 * re-mark, search miss, user cancel, self-supersedence reject, unknown id.
 *
 * These tests do not spawn `nlm` — they call the same function the binary
 * calls, with the same store. That keeps them fast and deterministic.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../src/core/recall/recall-service.js";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import {
  executeSupersede,
  type SessionCandidate,
  type SupersedeIO,
} from "../../src/cli/supersede.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
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

interface CapturedIO extends SupersedeIO {
  readonly info_lines: string[];
  readonly warn_lines: string[];
  readonly confirm_link_calls: { pred: string; succ: string }[];
  readonly confirm_overwrite_calls: { pred: string; existing: string; replacement: string }[];
  queryAnswers: string[];
  candidateAnswers: (string | null)[];
  reasonAnswer: string | null;
  confirmAnswer: boolean;
  confirmOverwriteAnswer: boolean;
}

function makeIO(overrides: Partial<CapturedIO> = {}): CapturedIO {
  const captured: CapturedIO = {
    info_lines: [],
    warn_lines: [],
    confirm_link_calls: [],
    confirm_overwrite_calls: [],
    queryAnswers: overrides.queryAnswers ?? [],
    candidateAnswers: overrides.candidateAnswers ?? [],
    reasonAnswer: overrides.reasonAnswer ?? "",
    confirmAnswer: overrides.confirmAnswer ?? true,
    confirmOverwriteAnswer: overrides.confirmOverwriteAnswer ?? false,
    async promptQuery() {
      return captured.queryAnswers.shift() ?? null;
    },
    async promptCandidate(_label, candidates: ReadonlyArray<SessionCandidate>) {
      const next = captured.candidateAnswers.shift();
      if (next === undefined) return candidates[0]?.id ?? null;
      return next;
    },
    async promptReason() {
      return captured.reasonAnswer;
    },
    async confirmLink(pred, succ) {
      captured.confirm_link_calls.push({ pred: pred.label, succ: succ.label });
      return captured.confirmAnswer;
    },
    async confirmOverwrite(pred, existing, replacement) {
      captured.confirm_overwrite_calls.push({
        pred: pred.label,
        existing: existing.label,
        replacement: replacement.label,
      });
      return captured.confirmOverwriteAnswer;
    },
    info(line) {
      captured.info_lines.push(line);
    },
    warn(line) {
      captured.warn_lines.push(line);
    },
  };
  return captured;
}

describe("executeSupersede", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  let recall: RecallService;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-supersede-cli-"));
    process.env["NLM_SUPERSEDENCE_LOG"] = join(tmp, "supersedence-log.jsonl");
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
    const olderSess = makeSession({
      id: "sess_old",
      label: "pgvector setup notes",
      entities: ["pgvector"],
      decisions: ["chose pgvector"],
    });
    const newerSess = makeSession({
      id: "sess_new",
      label: "qdrant migration plan",
      entities: ["qdrant", "pgvector"],
      decisions: ["switched to qdrant"],
    });
    store.insertSessionForTest(olderSess);
    store.insertSessionForTest(newerSess);
    store.insertEmbeddingForTest("sess_old", unit([1, 0, 0]));
    store.insertEmbeddingForTest("sess_new", unit([0, 1, 0]));
    recall = new RecallService({ store, llm: new FixedEmbedder(unit([0, 1, 0])) });
  });

  afterEach(async () => {
    await storage.close();
    delete process.env["NLM_SUPERSEDENCE_LOG"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("marks a superseded link end-to-end via interactive prompts", async () => {
    const io = makeIO({
      queryAnswers: ["pgvector", "qdrant"],
      candidateAnswers: ["sess_old", "sess_new"],
      reasonAnswer: "swapped after benchmark",
      confirmAnswer: true,
    });
    const result = await executeSupersede({ store, recall, io }, {});
    expect(result.kind).toBe("marked");
    if (result.kind !== "marked") return;
    expect(result.predecessor).toBe("sess_old");
    expect(result.successor).toBe("sess_new");
    expect(result.reason).toBe("swapped after benchmark");

    const updated = await store.getById("sess_old");
    expect(updated?.status).toBe("superseded");
    expect(updated?.supersededBy).toBe("sess_new");
  });

  it("non-interactive path with both ids and --yes skips all prompts", async () => {
    const io = makeIO();
    const result = await executeSupersede(
      { store, recall, io },
      { predecessor: "sess_old", successor: "sess_new", reason: "from arg", yes: true },
    );
    expect(result.kind).toBe("marked");
    expect(io.warn_lines).toEqual([]);
    const updated = await store.getById("sess_old");
    expect(updated?.supersededBy).toBe("sess_new");
  });

  it("returns noop on re-mark of an already-superseded pair without writing", async () => {
    await store.markSuperseded("sess_old", "sess_new");
    // Wrap the store so we can assert markSuperseded is not called a second
    // time — the noop branch must short-circuit before any write fires
    // (regression guard for B2 — ordering bug where the write always ran).
    let markCallCount = 0;
    const wrappedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "markSuperseded") {
          return async (a: string, b: string) => {
            markCallCount += 1;
            return target.markSuperseded(a, b);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const io = makeIO();
    const result = await executeSupersede(
      { store: wrappedStore, recall, io },
      { predecessor: "sess_old", successor: "sess_new", yes: true },
    );
    expect(result.kind).toBe("noop");
    expect(markCallCount).toBe(0);
    expect(io.info_lines.some((l) => l.includes("already existed"))).toBe(true);
  });

  it("requires explicit overwrite confirmation when the predecessor already points elsewhere (B1)", async () => {
    // Seed a third session so we have a meaningful "existing successor".
    const middleSess = makeSession({
      id: "sess_mid",
      label: "interim plan",
      entities: ["pgvector"],
    });
    store.insertSessionForTest(middleSess);
    await store.markSuperseded("sess_old", "sess_mid");

    const declining = makeIO({ confirmOverwriteAnswer: false });
    const declined = await executeSupersede(
      { store, recall, io: declining },
      { predecessor: "sess_old", successor: "sess_new" },
    );
    expect(declined.kind).toBe("cancelled");
    if (declined.kind !== "cancelled") return;
    expect(declined.reason).toBe("user-declined-overwrite");
    expect(declining.confirm_overwrite_calls).toHaveLength(1);
    expect(declining.confirm_overwrite_calls[0]?.existing).toBe("interim plan");
    expect(declining.confirm_overwrite_calls[0]?.replacement).toBe("qdrant migration plan");

    // Store should still reflect the old link — overwrite was declined.
    const stillOld = await store.getById("sess_old");
    expect(stillOld?.supersededBy).toBe("sess_mid");

    // Now run again, this time approving the overwrite.
    const approving = makeIO({ confirmOverwriteAnswer: true, confirmAnswer: true });
    const approved = await executeSupersede(
      { store, recall, io: approving },
      { predecessor: "sess_old", successor: "sess_new" },
    );
    expect(approved.kind).toBe("marked");
    const updated = await store.getById("sess_old");
    expect(updated?.supersededBy).toBe("sess_new");
  });

  it("--yes suppresses the overwrite confirmation (escape hatch for scripted flows)", async () => {
    const middleSess = makeSession({ id: "sess_mid", label: "interim plan" });
    store.insertSessionForTest(middleSess);
    await store.markSuperseded("sess_old", "sess_mid");

    const io = makeIO({ confirmOverwriteAnswer: false });
    const result = await executeSupersede(
      { store, recall, io },
      { predecessor: "sess_old", successor: "sess_new", yes: true },
    );
    expect(result.kind).toBe("marked");
    expect(io.confirm_overwrite_calls).toHaveLength(0);
  });

  it("confirmLink receives full SessionCandidate with label and date (B3)", async () => {
    const io = makeIO({ confirmAnswer: true });
    const result = await executeSupersede(
      { store, recall, io },
      { predecessor: "sess_old", successor: "sess_new" },
    );
    expect(result.kind).toBe("marked");
    expect(io.confirm_link_calls).toHaveLength(1);
    // Regression guard: confirm dialog must surface labels, not opaque IDs.
    expect(io.confirm_link_calls[0]?.pred).toBe("pgvector setup notes");
    expect(io.confirm_link_calls[0]?.succ).toBe("qdrant migration plan");
  });

  it("warns and cancels when an explicit successor id is unknown", async () => {
    const io = makeIO();
    const result = await executeSupersede(
      { store, recall, io },
      { predecessor: "sess_old", successor: "sess_ghost", yes: true },
    );
    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") return;
    expect(result.reason).toBe("unknown-id");
    expect(io.warn_lines.some((l) => l.includes("sess_ghost"))).toBe(true);
  });

  it("rejects when predecessor equals successor", async () => {
    const io = makeIO();
    const result = await executeSupersede(
      { store, recall, io },
      { predecessor: "sess_old", successor: "sess_old", yes: true },
    );
    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") return;
    expect(result.reason).toBe("same-session");
    expect(io.warn_lines.some((l) => l.includes("same session"))).toBe(true);
  });

  it("cancels when user declines confirmation", async () => {
    const io = makeIO({ confirmAnswer: false });
    const result = await executeSupersede(
      { store, recall, io },
      { predecessor: "sess_old", successor: "sess_new" },
    );
    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") return;
    expect(result.reason).toBe("user-declined-confirm");
    const old = await store.getById("sess_old");
    expect(old?.status).not.toBe("superseded");
  });

  it("cancels when a query returns no matches", async () => {
    // Use an embedder that signals "ollama unreachable" so RecallService
    // skips the semantic branch and the keyword path alone (which won't
    // match xyzzy) drives the no-matches outcome deterministically.
    const keywordOnlyRecall = new RecallService({
      store,
      llm: {
        async embed() {
          throw new LLMUnreachableError("test-stub");
        },
        async classify() {
          throw new Error("not used");
        },
      },
    });
    const io = makeIO({ queryAnswers: ["xyzzy_nothing_matches"] });
    const result = await executeSupersede(
      { store, recall: keywordOnlyRecall, io },
      {},
    );
    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") return;
    expect(result.reason).toBe("no-matches");
  });

  it("warns and cancels when an explicit predecessor id is unknown", async () => {
    const io = makeIO();
    const result = await executeSupersede(
      { store, recall, io },
      { predecessor: "sess_ghost", successor: "sess_new", yes: true },
    );
    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") return;
    expect(result.reason).toBe("unknown-id");
    expect(io.warn_lines.some((l) => l.includes("sess_ghost"))).toBe(true);
  });

  it("cancels when user aborts the predecessor query (Ctrl-C)", async () => {
    const io = makeIO({ queryAnswers: [] }); // promptQuery returns null
    const result = await executeSupersede({ store, recall, io }, {});
    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") return;
    expect(result.reason).toBe("user-cancelled-query");
  });
});
