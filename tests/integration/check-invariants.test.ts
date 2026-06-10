/**
 * check-invariants — SQLite backend: seed violation shapes → detected; clean
 * DB → all pass; --fix repairs I1+I2 and is idempotent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import {
  runChecksOnSqlite,
  applyFixOnSqlite,
} from "../../src/core/integrity/check-invariants.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("check-invariants (SQLite)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-invariants-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("clean DB passes all checks", () => {
    store.insertSessionForTest(makeSession({ id: "s1" }));
    store.insertSessionForTest(makeSession({ id: "s2" }));
    const violations = runChecksOnSqlite(store.rawDb());
    expect(violations).toHaveLength(0);
  });

  describe("I1 — self-loop edges", () => {
    it("detects self-loop edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s1", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      const i1 = violations.find((v) => v.id === "I1");
      expect(i1).toBeDefined();
      expect(i1!.count).toBe(1);
      expect(i1!.sampleIds).toContain("s1");
    });

    it("does not flag normal supersedes edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s2", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I1")).toBeUndefined();
    });
  });

  describe("I2 — orphaned superseded sessions", () => {
    it("detects superseded session with no incoming edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "superseded" }));
      const violations = runChecksOnSqlite(store.rawDb());
      const i2 = violations.find((v) => v.id === "I2");
      expect(i2).toBeDefined();
      expect(i2!.count).toBe(1);
      expect(i2!.sampleIds).toContain("s1");
    });

    it("does not flag superseded session with real incoming edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "superseded" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s2", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I2")).toBeUndefined();
    });

    it("I2 matches kind: superseded with only a replaces edge is a violation", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "superseded" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'replaces')")
        .run("s2", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      const i2 = violations.find((v) => v.id === "I2");
      expect(i2).toBeDefined();
      expect(i2!.sampleIds).toContain("s1");
    });
  });

  describe("I2r — orphaned replaced sessions", () => {
    it("detects replaced session with no incoming replaces edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "replaced" }));
      const violations = runChecksOnSqlite(store.rawDb());
      const i2r = violations.find((v) => v.id === "I2r");
      expect(i2r).toBeDefined();
      expect(i2r!.sampleIds).toContain("s1");
    });

    it("does not flag replaced session with real incoming replaces edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "replaced" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'replaces')")
        .run("s2", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I2r")).toBeUndefined();
    });

    it("I2r matches kind: replaced with only a supersedes edge is a violation", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "replaced" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s2", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      const i2r = violations.find((v) => v.id === "I2r");
      expect(i2r).toBeDefined();
      expect(i2r!.sampleIds).toContain("s1");
    });
  });

  describe("I3 — cycle detection", () => {
    it("detects cycle in supersedes graph", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.insertSessionForTest(makeSession({ id: "s3" }));
      const db = store.rawDb();
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s2", "s1");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s3", "s2");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s1", "s3");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I3")).toBeDefined();
    });

    it("does not flag acyclic graph", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.insertSessionForTest(makeSession({ id: "s3" }));
      const db = store.rawDb();
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s2", "s1");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s3", "s2");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I3")).toBeUndefined();
    });

    it("detects cycle across mixed supersedes/replaces edges", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.insertSessionForTest(makeSession({ id: "s3" }));
      const db = store.rawDb();
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s2", "s1");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'replaces')").run("s3", "s2");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s1", "s3");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I3")).toBeDefined();
    });
  });

  describe("I4 — dangling edge endpoints", () => {
    it("detects edge referencing missing session", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      const db = store.rawDb();
      // Temporarily disable FK checks to seed a corrupted state that the
      // integrity check is designed to detect.
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s1", "ghost-id");
      db.pragma("foreign_keys = ON");
      const violations = runChecksOnSqlite(store.rawDb());
      const i4 = violations.find((v) => v.id === "I4");
      expect(i4).toBeDefined();
      expect(i4!.sampleIds).toContain("ghost-id");
    });
  });

  describe("I5 — facts integrity", () => {
    it("detects duplicate active facts for same (subject, predicate)", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 'x', 'color', 'red', 's1', 1.0)`).run("f1");
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 'x', 'color', 'blue', 's1', 1.0)`).run("f2");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I5a")).toBeDefined();
    });

    it("detects fact with dangling superseded_by reference", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      const db = store.rawDb();
      // Temporarily disable FK checks to seed a corrupted state that the
      // integrity check is designed to detect.
      db.pragma("foreign_keys = OFF");
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence, superseded_by)
        VALUES (?, 'attribute', 'x', 'color', 'red', 's1', 1.0, 'nonexistent-fact-id')`).run("f1");
      db.pragma("foreign_keys = ON");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I5b")).toBeDefined();
    });

    it("does not flag facts with valid superseded_by", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 'x', 'color', 'red', 's1', 1.0)`).run("f1");
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence, superseded_by)
        VALUES (?, 'attribute', 'x', 'color', 'blue', 's1', 1.0, 'f1')`).run("f2");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I5a")).toBeUndefined();
      expect(violations.find((v) => v.id === "I5b")).toBeUndefined();
    });
  });

  describe("I6 — adapter_state orphan references", () => {
    it("detects adapter_state.session_id referencing missing session", () => {
      const db = store.rawDb();
      db.prepare(`INSERT INTO adapter_state (adapter_name, source_path, session_id) VALUES (?, ?, ?)`)
        .run("claude-code", "/path/to/file.jsonl", "ghost-session-id");
      const violations = runChecksOnSqlite(store.rawDb());
      const i6 = violations.find((v) => v.id === "I6");
      expect(i6).toBeDefined();
      expect(i6!.sampleIds).toContain("ghost-session-id");
    });

    it("does not flag adapter_state.session_id pointing to real session", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO adapter_state (adapter_name, source_path, session_id) VALUES (?, ?, ?)`)
        .run("claude-code", "/path/to/file.jsonl", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I6")).toBeUndefined();
    });

    it("does not flag adapter_state rows with null session_id", () => {
      const db = store.rawDb();
      db.prepare(`INSERT INTO adapter_state (adapter_name, source_path) VALUES (?, ?)`)
        .run("claude-code", "/path/to/file.jsonl");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I6")).toBeUndefined();
    });
  });

  describe("--fix: applyFix", () => {
    it("deletes self-loop edges (I1 repair)", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s1", "s1");
      const report = applyFixOnSqlite(store.rawDb());
      expect(report.deletedSelfLoops).toBe(1);
      const remaining = store.rawDb()
        .prepare<[], { n: number }>("SELECT count(*) AS n FROM session_edges WHERE from_session = to_session")
        .get();
      expect(remaining?.n).toBe(0);
    });

    it("restores orphaned superseded sessions to closed (I2 repair)", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "superseded" }));
      const report = applyFixOnSqlite(store.rawDb());
      expect(report.restoredToClosed).toBe(1);
      const row = store.rawDb()
        .prepare<[], { status: string }>("SELECT status FROM sessions WHERE id = 's1'")
        .get();
      expect(row?.status).toBe("closed");
    });

    it("restores orphaned replaced sessions to closed (I2r repair)", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "replaced" }));
      const report = applyFixOnSqlite(store.rawDb());
      expect(report.restoredToClosed).toBe(1);
      const row = store.rawDb()
        .prepare<[], { status: string }>("SELECT status FROM sessions WHERE id = 's1'")
        .get();
      expect(row?.status).toBe("closed");
    });

    it("does not restore replaced session with real incoming replaces edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "replaced" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'replaces')")
        .run("s2", "s1");
      const report = applyFixOnSqlite(store.rawDb());
      expect(report.restoredToClosed).toBe(0);
      const row = store.rawDb()
        .prepare<[], { status: string }>("SELECT status FROM sessions WHERE id = 's1'")
        .get();
      expect(row?.status).toBe("replaced");
    });

    it("does not restore session with real incoming supersedes edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "superseded" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s2", "s1");
      const report = applyFixOnSqlite(store.rawDb());
      expect(report.restoredToClosed).toBe(0);
      const row = store.rawDb()
        .prepare<[], { status: string }>("SELECT status FROM sessions WHERE id = 's1'")
        .get();
      expect(row?.status).toBe("superseded");
    });

    it("is idempotent: running fix twice reports 0 changes on second run", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s1", "s1");
      store.insertSessionForTest(makeSession({ id: "s2", status: "superseded" }));
      applyFixOnSqlite(store.rawDb());
      const second = applyFixOnSqlite(store.rawDb());
      expect(second.deletedSelfLoops).toBe(0);
      expect(second.restoredToClosed).toBe(0);
    });
  });
});
