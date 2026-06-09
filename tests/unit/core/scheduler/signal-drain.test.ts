/**
 * Signal drain integration test: proves that chunk.signals are drained to
 * the SignalStore even when the classifier throws and the session is never
 * inserted. Correction B from the task spec.
 */

import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ScanScheduler } from "../../../../src/core/scheduler/scheduler.js";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import type { SignalStore } from "../../../../src/ports/signal-store.js";
import type { Signal } from "../../../../src/shared/types.js";
import type {
  TranscriptAdapter,
  SessionChunk,
} from "../../../../src/ports/transcript-adapter.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

async function memStore() {
  const tmp = mkdtempSync(join(tmpdir(), "nlm-sched-sig-"));
  const storage = SqliteStorage.create({
    dbPath: join(tmp, "c.sqlite"),
    migrationsDir: MIGRATIONS_DIR,
  });
  await storage.init();
  return storage;
}

function writeTempJsonl(dir: string, name: string): string {
  const path = join(dir, name);
  // Any non-empty content; parseSession is stubbed so content doesn't matter.
  writeFileSync(path, '{"type":"user","message":{"content":"hi"}}\n');
  // Age the file so scanOnce's mtime gate passes (idleMinutes=0 means all ages pass).
  const oldT = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(path, oldT, oldT);
  return path;
}

function chunkWithSignals(sourcePath: string, signals: unknown[]): SessionChunk {
  return {
    id: "pi_1",
    runtime: "pi/1.0",
    runtimeSessionId: "pi_1",
    sourcePath,
    startedAt: "2026-06-09T18:00:00Z",
    endedAt: "2026-06-09T18:05:00Z",
    durationMin: 5,
    turnCount: 2,
    byteRange: [0, 100],
    projectDir: "/repo/x",
    gitBranch: "",
    text: "[user] hi",
    label: "hi",
    signals,
  };
}

describe("ScanScheduler signal drain", () => {
  it("drains chunk.signals even when classification fails", async () => {
    const storage = await memStore();
    const tmp = mkdtempSync(join(tmpdir(), "nlm-sig-files-"));
    const transcriptPath = writeTempJsonl(tmp, "session.jsonl");

    const stored: Signal[] = [];
    const signalStore: SignalStore = {
      async insert(s) {
        stored.push(s);
      },
      async insertMany(ss) {
        stored.push(...ss);
      },
      async listForAggregation() {
        return [];
      },
      async countSince() {
        return 0;
      },
      async pruneOlderThan() {
        return 0;
      },
    };

    const adapter: TranscriptAdapter = {
      name: "pi",
      runtimeVersion: "pi/1.0",
      transcriptKind: "pi-jsonl",
      detect: () => ({ adapterName: "pi", enabled: true, path: null, hint: null }),
      discover: async () => [transcriptPath],
      parseSession: async () =>
        chunkWithSignals(transcriptPath, [
          {
            kind: "gate",
            producer: "qg",
            outcome: "fail",
            model: "m",
            repo: "/repo/x",
            detail: { step: "types" },
            ts: "2026-06-09T18:01:00Z",
          },
        ]),
    };

    const scheduler = new ScanScheduler({
      store: storage.sessions,
      adapters: [adapter],
      classifier: {
        embed: async () => {
          throw new Error("no");
        },
        classify: async () => {
          throw new Error("classify fail");
        },
      },
      embedder: null,
      signalStore,
      installScope: "install-test",
      idleMinutes: 0,
      logger: () => {},
    });

    const report = await scheduler.tick();
    expect(report.chunksSeen).toBe(1);
    expect(report.classifyFailures).toBe(1);
    expect(report.inserted).toBe(0);

    expect(stored).toHaveLength(1);
    expect(stored[0]!.step).toBe("types");
    expect(stored[0]!.installScope).toBe("install-test");

    await storage.close();
  });

  it("skips signal drain when no signalStore is configured (backwards compat)", async () => {
    const storage = await memStore();
    const tmp = mkdtempSync(join(tmpdir(), "nlm-sig-compat-"));
    const transcriptPath = writeTempJsonl(tmp, "session.jsonl");

    const adapter: TranscriptAdapter = {
      name: "pi",
      runtimeVersion: "pi/1.0",
      transcriptKind: "pi-jsonl",
      detect: () => ({ adapterName: "pi", enabled: true, path: null, hint: null }),
      discover: async () => [transcriptPath],
      parseSession: async () =>
        chunkWithSignals(transcriptPath, [
          { kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "/r", detail: null, ts: "2026-06-09T18:01:00Z" },
        ]),
    };

    const scheduler = new ScanScheduler({
      store: storage.sessions,
      adapters: [adapter],
      classifier: {
        embed: async () => { throw new Error("no"); },
        classify: async () => { throw new Error("classify fail"); },
      },
      embedder: null,
      // no signalStore
      idleMinutes: 0,
      logger: () => {},
    });

    // Should not throw, signals silently not drained
    await expect(scheduler.tick()).resolves.toBeDefined();

    await storage.close();
  });

  it("skips malformed signals but drains valid ones", async () => {
    const storage = await memStore();
    const tmp = mkdtempSync(join(tmpdir(), "nlm-sig-malformed-"));
    const transcriptPath = writeTempJsonl(tmp, "session.jsonl");

    const stored: Signal[] = [];
    const signalStore: SignalStore = {
      async insert(s) { stored.push(s); },
      async insertMany(ss) { stored.push(...ss); },
      async listForAggregation() { return []; },
      async countSince() { return 0; },
      async pruneOlderThan() { return 0; },
    };

    const adapter: TranscriptAdapter = {
      name: "pi",
      runtimeVersion: "pi/1.0",
      transcriptKind: "pi-jsonl",
      detect: () => ({ adapterName: "pi", enabled: true, path: null, hint: null }),
      discover: async () => [transcriptPath],
      parseSession: async () =>
        chunkWithSignals(transcriptPath, [
          "not-an-object",                                                         // malformed
          { kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "/r", detail: { step: "lint" }, ts: "2026-06-09T18:02:00Z" }, // valid
        ]),
    };

    const scheduler = new ScanScheduler({
      store: storage.sessions,
      adapters: [adapter],
      classifier: {
        embed: async () => { throw new Error("no"); },
        classify: async () => { throw new Error("classify fail"); },
      },
      embedder: null,
      signalStore,
      installScope: "install-test",
      idleMinutes: 0,
      logger: () => {},
    });

    await scheduler.tick();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.step).toBe("lint");

    await storage.close();
  });

  it("skips the drain entirely when NLM_SIGNALS_ENABLED=0", async () => {
    const prev = process.env["NLM_SIGNALS_ENABLED"];
    process.env["NLM_SIGNALS_ENABLED"] = "0";
    try {
      const storage = await memStore();
      const dir = mkdtempSync(join(tmpdir(), "nlm-sched-gate-"));
      const transcriptPath = writeTempJsonl(dir, "sess.jsonl");
      const stored: Signal[] = [];
      const signalStore: SignalStore = {
        async insert(s) { stored.push(s); },
        async insertMany(ss) { stored.push(...ss); },
        async listForAggregation() { return []; },
        async countSince() { return 0; },
        async pruneOlderThan() { return 0; },
      };
      const adapter: TranscriptAdapter = {
        name: "pi",
        runtimeVersion: "pi/1.0",
        transcriptKind: "pi-jsonl",
        detect: () => ({ adapterName: "pi", enabled: true, path: null, hint: null }),
        discover: async () => [transcriptPath],
        parseSession: async () =>
          chunkWithSignals(transcriptPath, [
            { kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "/r", detail: { step: "lint" }, ts: "2026-06-09T18:02:00Z" },
          ]),
      };
      const scheduler = new ScanScheduler({
        store: storage.sessions,
        adapters: [adapter],
        classifier: {
          embed: async () => { throw new Error("no"); },
          classify: async () => { throw new Error("classify fail"); },
        },
        embedder: null,
        signalStore,
        installScope: "install-test",
        idleMinutes: 0,
        logger: () => {},
      });
      await scheduler.tick();
      expect(stored).toHaveLength(0);
      await storage.close();
    } finally {
      if (prev === undefined) delete process.env["NLM_SIGNALS_ENABLED"];
      else process.env["NLM_SIGNALS_ENABLED"] = prev;
    }
  });
});
