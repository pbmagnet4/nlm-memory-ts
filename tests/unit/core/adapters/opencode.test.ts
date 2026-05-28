/**
 * OpenCodeAdapter unit tests.
 *
 * Each test builds an in-memory SQLite DB seeded with the minimal schema
 * OpenCode uses, then writes it to a temp file so the adapter can open it
 * with better-sqlite3 in readonly mode.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenCodeAdapter } from "../../../../src/core/adapters/opencode.js";

// ── Schema helpers ────────────────────────────────────────────────────────────

function createDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'proj_1',
      directory TEXT NOT NULL DEFAULT '/tmp/test',
      title TEXT NOT NULL DEFAULT 'New session',
      version TEXT NOT NULL DEFAULT '1.0',
      slug TEXT NOT NULL DEFAULT 'test',
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );
  `);
  return db;
}

function addSession(
  db: Database.Database,
  opts: {
    id: string;
    directory?: string;
    title?: string;
    timeCreated?: number;
    timeUpdated?: number;
    archived?: boolean;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO session (id, directory, title, time_created, time_updated, time_archived)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.directory ?? "/tmp/proj",
    opts.title ?? "New session",
    opts.timeCreated ?? now - 3600_000,
    opts.timeUpdated ?? now,
    opts.archived ? now : null,
  );
}

function addMessage(
  db: Database.Database,
  sessionId: string,
  msgId: string,
  role: "user" | "assistant",
  timeCreated: number,
): void {
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, data)
     VALUES (?, ?, ?, ?)`,
  ).run(msgId, sessionId, timeCreated, JSON.stringify({ role }));
}

function addTextPart(
  db: Database.Database,
  sessionId: string,
  msgId: string,
  text: string,
  opts: { ignored?: boolean } = {},
): void {
  const id = `part_${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    msgId,
    sessionId,
    Date.now(),
    JSON.stringify({ type: "text", text, ...(opts.ignored ? { ignored: true } : {}) }),
  );
}

function addToolPart(
  db: Database.Database,
  sessionId: string,
  msgId: string,
  toolName: string,
): void {
  const id = `part_${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    msgId,
    sessionId,
    Date.now(),
    JSON.stringify({ type: "tool", tool: toolName, callID: "call_1", state: {} }),
  );
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmp: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-oc-"));
  dbPath = join(tmp, "opencode.db");
  db = createDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ── detect() ─────────────────────────────────────────────────────────────────

describe("OpenCodeAdapter.detect", () => {
  it("returns enabled=true when DB file exists", () => {
    const adapter = new OpenCodeAdapter({ dbPath });
    expect(adapter.detect().enabled).toBe(true);
    expect(adapter.detect().path).toBe(dbPath);
  });

  it("returns enabled=false when DB file is absent", () => {
    const adapter = new OpenCodeAdapter({ dbPath: join(tmp, "missing.db") });
    expect(adapter.detect().enabled).toBe(false);
    expect(adapter.detect().path).toBeNull();
  });
});

// ── discover() ───────────────────────────────────────────────────────────────

describe("OpenCodeAdapter.discover", () => {
  it("returns all non-archived session IDs", async () => {
    addSession(db, { id: "sess_a" });
    addSession(db, { id: "sess_b" });
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    const ids = await adapter.discover();
    expect(ids).toContain("sess_a");
    expect(ids).toContain("sess_b");
    expect(ids.length).toBe(2);
  });

  it("excludes archived sessions", async () => {
    addSession(db, { id: "sess_live" });
    addSession(db, { id: "sess_archived", archived: true });
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    const ids = await adapter.discover();
    expect(ids).toContain("sess_live");
    expect(ids).not.toContain("sess_archived");
  });

  it("respects the since option", async () => {
    const old = Date.now() - 7 * 24 * 3600_000;
    const recent = Date.now() - 3600_000;
    addSession(db, { id: "sess_old", timeCreated: old - 1000, timeUpdated: old });
    addSession(db, { id: "sess_new", timeCreated: recent - 1000, timeUpdated: recent });
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    const cutoff = new Date(old + 1);
    const ids = await adapter.discover({ since: cutoff });
    expect(ids).toContain("sess_new");
    expect(ids).not.toContain("sess_old");
  });

  it("returns empty array when DB is absent", async () => {
    db.close();
    const adapter = new OpenCodeAdapter({ dbPath: join(tmp, "no.db") });
    const ids = await adapter.discover();
    expect(ids).toEqual([]);
  });
});

// ── parseSession() ────────────────────────────────────────────────────────────

describe("OpenCodeAdapter.parseSession", () => {
  it("returns null for an unknown session ID", async () => {
    db.close();
    const adapter = new OpenCodeAdapter({ dbPath });
    expect(await adapter.parseSession("nonexistent")).toBeNull();
  });

  it("returns null when session has no usable turns", async () => {
    addSession(db, { id: "sess_empty" });
    // message with only an ignored text part
    addMessage(db, "sess_empty", "msg_1", "user", Date.now());
    addTextPart(db, "sess_empty", "msg_1", "ignored text", { ignored: true });
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    expect(await adapter.parseSession("sess_empty")).toBeNull();
  });

  it("builds the correct turn count and roles", async () => {
    const now = Date.now();
    addSession(db, { id: "sess_1", timeCreated: now - 5000, timeUpdated: now });
    addMessage(db, "sess_1", "msg_u1", "user", now - 4000);
    addTextPart(db, "sess_1", "msg_u1", "hello");
    addMessage(db, "sess_1", "msg_a1", "assistant", now - 3000);
    addTextPart(db, "sess_1", "msg_a1", "world");
    addMessage(db, "sess_1", "msg_u2", "user", now - 2000);
    addTextPart(db, "sess_1", "msg_u2", "follow-up");
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_1");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(3);
    expect(chunk!.id).toBe("oc_sess_1");
    expect(chunk!.runtime).toBe("opencode/1.0");
  });

  it("skips ignored text parts", async () => {
    const now = Date.now();
    addSession(db, { id: "sess_2", timeCreated: now - 2000, timeUpdated: now });
    addMessage(db, "sess_2", "msg_1", "user", now - 1000);
    addTextPart(db, "sess_2", "msg_1", "visible");
    addTextPart(db, "sess_2", "msg_1", "ignored part", { ignored: true });
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_2");
    expect(chunk!.text).toContain("visible");
    expect(chunk!.text).not.toContain("ignored part");
  });

  it("summarizes tool parts as [tool: <name>]", async () => {
    const now = Date.now();
    addSession(db, { id: "sess_3", timeCreated: now - 2000, timeUpdated: now });
    addMessage(db, "sess_3", "msg_u", "user", now - 1500);
    addTextPart(db, "sess_3", "msg_u", "run a command");
    addMessage(db, "sess_3", "msg_a", "assistant", now - 1000);
    addToolPart(db, "sess_3", "msg_a", "bash");
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_3");
    expect(chunk!.text).toContain("[tool: bash]");
    expect(chunk!.turnCount).toBe(2);
  });

  it("uses the session title as label when it is not 'New session'", async () => {
    const now = Date.now();
    addSession(db, { id: "sess_4", title: "Fix the auth bug", timeCreated: now - 2000, timeUpdated: now });
    addMessage(db, "sess_4", "msg_1", "user", now - 1000);
    addTextPart(db, "sess_4", "msg_1", "first message");
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_4");
    expect(chunk!.label).toBe("Fix the auth bug");
  });

  it("falls back to first user turn for label when title is 'New session'", async () => {
    const now = Date.now();
    addSession(db, { id: "sess_5", title: "New session", timeCreated: now - 2000, timeUpdated: now });
    addMessage(db, "sess_5", "msg_1", "user", now - 1000);
    addTextPart(db, "sess_5", "msg_1", "implement the feature");
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_5");
    expect(chunk!.label).toBe("implement the feature");
  });

  it("sets sourcePath to dbPath::sessionId", async () => {
    const now = Date.now();
    addSession(db, { id: "sess_6", timeCreated: now - 1000, timeUpdated: now });
    addMessage(db, "sess_6", "msg_1", "user", now - 500);
    addTextPart(db, "sess_6", "msg_1", "hello");
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_6");
    expect(chunk!.sourcePath).toBe(`${dbPath}::sess_6`);
  });

  it("sets projectDir from session directory column", async () => {
    const now = Date.now();
    addSession(db, { id: "sess_7", directory: "/home/user/myproject", timeCreated: now - 1000, timeUpdated: now });
    addMessage(db, "sess_7", "msg_1", "user", now - 500);
    addTextPart(db, "sess_7", "msg_1", "hello");
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_7");
    expect(chunk!.projectDir).toBe("/home/user/myproject");
  });

  it("returns null when DB is absent", async () => {
    db.close();
    const adapter = new OpenCodeAdapter({ dbPath: join(tmp, "absent.db") });
    expect(await adapter.parseSession("any")).toBeNull();
  });

  it("timestamps are ISO strings", async () => {
    const now = Date.now();
    addSession(db, { id: "sess_8", timeCreated: now - 5000, timeUpdated: now });
    addMessage(db, "sess_8", "msg_1", "user", now - 4000);
    addTextPart(db, "sess_8", "msg_1", "hello");
    db.close();

    const adapter = new OpenCodeAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_8");
    expect(chunk!.startedAt).toMatch(/T/);
    expect(chunk!.endedAt).toMatch(/T/);
  });
});

// ── runtime metadata ──────────────────────────────────────────────────────────

describe("OpenCodeAdapter metadata", () => {
  it("has the correct name, runtimeVersion, and transcriptKind", () => {
    const adapter = new OpenCodeAdapter({ dbPath });
    expect(adapter.name).toBe("opencode");
    expect(adapter.runtimeVersion).toBe("opencode/1.0");
    expect(adapter.transcriptKind).toBe("opencode-sqlite");
  });
});
