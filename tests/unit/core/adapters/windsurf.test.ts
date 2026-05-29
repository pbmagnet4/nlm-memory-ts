/**
 * WindsurfAdapter unit tests.
 *
 * Each test builds a fake Windsurf workspaceStorage directory tree with
 * in-memory SQLite DBs written to temp files so the adapter can open them
 * in readonly mode.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WindsurfAdapter } from "../../../../src/core/adapters/windsurf.js";

// ── Schema helpers ────────────────────────────────────────────────────────────

const CHAT_KEY = "workbench.panel.aichat.view.aichat.chatdata";

function createWorkspaceDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ItemTable (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

interface Bubble {
  type: "user" | "ai";
  text?: string;
  rawText?: string;
}

interface Tab {
  tabId: string;
  chatTitle?: string;
  lastSendTime?: number;
  bubbles?: Bubble[];
}

function writeChatData(db: Database.Database, tabs: Tab[]): void {
  db.prepare(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`).run(
    CHAT_KEY,
    JSON.stringify({ tabs }),
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmp: string;
let userDir: string;
let wsStorageDir: string;
let adapter: WindsurfAdapter;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-windsurf-"));
  userDir = join(tmp, "Windsurf", "User");
  wsStorageDir = join(userDir, "workspaceStorage");
  mkdirSync(wsStorageDir, { recursive: true });
  adapter = new WindsurfAdapter({ userDir });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function addWorkspace(name: string, tabs: Tab[]): string {
  const wsDir = join(wsStorageDir, name);
  mkdirSync(wsDir, { recursive: true });
  const dbPath = join(wsDir, "state.vscdb");
  const db = createWorkspaceDb(dbPath);
  writeChatData(db, tabs);
  db.close();
  return dbPath;
}

// ── detect() ─────────────────────────────────────────────────────────────────

describe("detect()", () => {
  it("returns enabled when userDir exists", () => {
    const result = adapter.detect();
    expect(result.enabled).toBe(true);
    expect(result.path).toBe(userDir);
    expect(result.hint).toBeNull();
  });

  it("returns disabled when userDir is absent", () => {
    const noDir = new WindsurfAdapter({ userDir: join(tmp, "nonexistent") });
    const result = noDir.detect();
    expect(result.enabled).toBe(false);
    expect(result.path).toBeNull();
    expect(result.hint).toMatch(/Windsurf/);
  });
});

// ── discover() ───────────────────────────────────────────────────────────────

describe("discover()", () => {
  it("returns empty array when workspaceStorage has no DBs", async () => {
    expect(await adapter.discover()).toEqual([]);
  });

  it("returns prefixed tabIds across workspace DBs", async () => {
    addWorkspace("ws1", [
      { tabId: "tab-aaa", bubbles: [{ type: "user", text: "Hello" }] },
    ]);
    addWorkspace("ws2", [
      { tabId: "tab-bbb", bubbles: [{ type: "user", text: "Hi" }] },
      { tabId: "tab-ccc", bubbles: [{ type: "ai", text: "Bye" }] },
    ]);

    const ids = await adapter.discover();
    expect([...ids].sort()).toEqual(["ws_tab-aaa", "ws_tab-bbb", "ws_tab-ccc"].sort());
  });

  it("skips tabs with no bubbles", async () => {
    addWorkspace("ws1", [
      { tabId: "empty-tab", bubbles: [] },
      { tabId: "good-tab", bubbles: [{ type: "user", text: "Hello" }] },
    ]);

    const ids = await adapter.discover();
    expect(ids).toEqual(["ws_good-tab"]);
  });

  it("deduplicates tabIds appearing in multiple workspaces", async () => {
    // Edge case: same tab ID in two workspace DBs (migration artifact)
    addWorkspace("ws1", [{ tabId: "dup-tab", bubbles: [{ type: "user", text: "A" }] }]);
    addWorkspace("ws2", [{ tabId: "dup-tab", bubbles: [{ type: "user", text: "B" }] }]);

    const ids = await adapter.discover();
    expect(ids.filter((id) => id === "ws_dup-tab").length).toBe(1);
  });

  it("filters by since using lastSendTime", async () => {
    const old = Date.now() - 10 * 24 * 3600_000;
    const recent = Date.now();
    addWorkspace("ws1", [
      { tabId: "old-tab", lastSendTime: old, bubbles: [{ type: "user", text: "Old" }] },
      { tabId: "new-tab", lastSendTime: recent, bubbles: [{ type: "user", text: "New" }] },
    ]);

    const cutoff = new Date(Date.now() - 5 * 24 * 3600_000);
    const ids = await adapter.discover({ since: cutoff });
    expect(ids).toEqual(["ws_new-tab"]);
  });

  it("includes tab with lastSendTime=0 even when since is set (zero means unknown age)", async () => {
    addWorkspace("ws1", [
      { tabId: "zero-ts-tab", lastSendTime: 0, bubbles: [{ type: "user", text: "Hi" }] },
    ]);

    const cutoff = new Date(); // very recent cutoff that would exclude everything with a real ts
    const ids = await adapter.discover({ since: cutoff });
    expect(ids).toContain("ws_zero-ts-tab");
  });
});

// ── parseSession() ────────────────────────────────────────────────────────────

describe("parseSession()", () => {
  it("returns null for unknown tabId", async () => {
    addWorkspace("ws1", [{ tabId: "real-tab", bubbles: [{ type: "user", text: "Hello" }] }]);
    expect(await adapter.parseSession("ghost-tab")).toBeNull();
  });

  it("returns null for tab with no usable bubbles", async () => {
    addWorkspace("ws1", [{ tabId: "empty-tab", bubbles: [] }]);
    expect(await adapter.parseSession("empty-tab")).toBeNull();
  });

  it("extracts user and assistant turns", async () => {
    addWorkspace("ws1", [
      {
        tabId: "chat-tab",
        chatTitle: "My chat",
        bubbles: [
          { type: "user", text: "Hello AI" },
          { type: "ai", rawText: "Hi human" },
        ],
      },
    ]);

    const chunk = await adapter.parseSession("chat-tab");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(2);
    expect(chunk!.text).toContain("user: Hello AI");
    expect(chunk!.text).toContain("assistant: Hi human");
  });

  it("prefers rawText over text for bubble content", async () => {
    addWorkspace("ws1", [
      {
        tabId: "rawtext-tab",
        bubbles: [
          { type: "user", rawText: "Raw question", text: "text version" },
        ],
      },
    ]);

    const chunk = await adapter.parseSession("rawtext-tab");
    expect(chunk!.text).toContain("Raw question");
    expect(chunk!.text).not.toContain("text version");
  });

  it("uses chatTitle as label", async () => {
    addWorkspace("ws1", [
      {
        tabId: "titled-tab",
        chatTitle: "Refactoring session",
        bubbles: [{ type: "user", text: "Let's refactor" }],
      },
    ]);

    const chunk = await adapter.parseSession("titled-tab");
    expect(chunk!.label).toBe("Refactoring session");
  });

  it("falls back to first user turn as label when chatTitle is absent", async () => {
    addWorkspace("ws1", [
      {
        tabId: "notitle-tab",
        bubbles: [{ type: "user", text: "What is a monad?" }],
      },
    ]);

    const chunk = await adapter.parseSession("notitle-tab");
    expect(chunk!.label).toBe("What is a monad?");
  });

  it("sets correct id prefix and runtimeSessionId", async () => {
    addWorkspace("ws1", [
      { tabId: "id-check", bubbles: [{ type: "user", text: "Hello" }] },
    ]);

    const chunk = await adapter.parseSession("id-check");
    expect(chunk!.runtimeSessionId).toBe("id-check");
    expect(chunk!.id).toMatch(/^ws_/);
  });

  it("sets sourcePath to dbPath::tabId", async () => {
    const dbPath = addWorkspace("ws1", [
      { tabId: "path-tab", bubbles: [{ type: "user", text: "Hello" }] },
    ]);

    const chunk = await adapter.parseSession("path-tab");
    expect(chunk!.sourcePath).toBe(`${dbPath}::path-tab`);
  });

  it("finds tab in second workspace when not in first", async () => {
    addWorkspace("ws1", [{ tabId: "tab-ws1", bubbles: [{ type: "user", text: "In ws1" }] }]);
    addWorkspace("ws2", [{ tabId: "tab-ws2", bubbles: [{ type: "user", text: "In ws2" }] }]);

    const chunk = await adapter.parseSession("tab-ws2");
    expect(chunk).not.toBeNull();
    expect(chunk!.text).toContain("In ws2");
  });

  it("skips bubbles with empty text", async () => {
    addWorkspace("ws1", [
      {
        tabId: "sparse-tab",
        bubbles: [
          { type: "user", text: "" },
          { type: "user", text: "Real question" },
          { type: "ai", text: "Real answer" },
        ],
      },
    ]);

    const chunk = await adapter.parseSession("sparse-tab");
    expect(chunk!.turnCount).toBe(2);
  });

  it("populates byteRange[1] equal to transcript byte length", async () => {
    addWorkspace("ws1", [
      {
        tabId: "bytes-tab",
        bubbles: [
          { type: "user", text: "Hello" },
          { type: "ai", text: "Hi" },
        ],
      },
    ]);

    const chunk = await adapter.parseSession("bytes-tab");
    expect(chunk!.byteRange[1]).toBe(Buffer.byteLength(chunk!.text, "utf8"));
  });
});

// ── global DB agent sessions (wsg_) ──────────────────────────────────────────

describe("global DB agent sessions (wsg_)", () => {
  let globalDb: Database.Database;
  let globalDbPath: string;

  beforeEach(() => {
    const globalDir = join(userDir, "globalStorage");
    mkdirSync(globalDir, { recursive: true });
    globalDbPath = join(globalDir, "state.vscdb");
    globalDb = new Database(globalDbPath);
  });

  afterEach(() => {
    try { globalDb.close(); } catch { /* already closed */ }
  });

  function addCursorDiskKVSession(
    composerId: string,
    opts: { name?: string; createdAt?: string; lastUpdatedAt?: string; conversation?: Array<{ type?: number; role?: string; text: string }> } = {},
  ): void {
    globalDb.exec(`CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);`);
    const data = {
      composerId,
      name: opts.name,
      createdAt: opts.createdAt ?? new Date(Date.now() - 3600_000).toISOString(),
      lastUpdatedAt: opts.lastUpdatedAt ?? new Date().toISOString(),
      conversation: opts.conversation ?? [],
    };
    globalDb.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
      `composerData:${composerId}`,
      JSON.stringify(data),
    );
    globalDb.close();
  }

  function addItemTableSession(
    composerId: string,
    opts: { name?: string; conversation?: Array<{ type?: number; role?: string; text: string }> } = {},
  ): void {
    globalDb.exec(`CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT);`);
    const data = {
      composerId,
      name: opts.name,
      conversation: opts.conversation ?? [],
    };
    // Use an agent-style key so the fallback LIKE query matches
    globalDb.prepare(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`).run(
      `cascade:${composerId}`,
      JSON.stringify(data),
    );
    globalDb.close();
  }

  it("discover() returns wsg_ ids from cursorDiskKV global sessions", async () => {
    addCursorDiskKVSession("agent-aaa", {
      conversation: [{ type: 1, text: "Hello" }],
    });

    const ids = await adapter.discover();
    expect(ids).toContain("wsg_agent-aaa");
  });

  it("discover() returns wsg_ ids from ItemTable fallback", async () => {
    addItemTableSession("flow-bbb", {
      conversation: [{ role: "user", text: "Hi" }],
    });

    const ids = await adapter.discover();
    expect(ids).toContain("wsg_flow-bbb");
  });

  it("parseSession(wsg_<id>) extracts turns via cursorDiskKV", async () => {
    addCursorDiskKVSession("agent-parse", {
      name: "My flow",
      conversation: [
        { type: 1, text: "Build a widget" },
        { type: 2, text: "Built!" },
      ],
    });

    const chunk = await adapter.parseSession("wsg_agent-parse");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(2);
    expect(chunk!.text).toContain("user: Build a widget");
    expect(chunk!.text).toContain("assistant: Built!");
    expect(chunk!.label).toBe("My flow");
    expect(chunk!.id).toMatch(/^wsg_/);
    expect(chunk!.runtimeSessionId).toBe("agent-parse");
  });

  it("parseSession(wsg_<id>) returns null when conversation is empty", async () => {
    addCursorDiskKVSession("empty-agent", { conversation: [] });
    expect(await adapter.parseSession("wsg_empty-agent")).toBeNull();
  });

  it("discover() wsg_ filters by since using lastUpdatedAt", async () => {
    const recentDb = new Database(globalDbPath);
    recentDb.exec(`CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);`);
    const old = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
    const recent = new Date().toISOString();
    const oldData = { composerId: "old-agent", lastUpdatedAt: old, conversation: [{ type: 1, text: "Old" }] };
    const newData = { composerId: "new-agent", lastUpdatedAt: recent, conversation: [{ type: 1, text: "New" }] };
    recentDb.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run("composerData:old-agent", JSON.stringify(oldData));
    recentDb.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run("composerData:new-agent", JSON.stringify(newData));
    recentDb.close();

    const cutoff = new Date(Date.now() - 5 * 24 * 3600_000);
    const ids = await adapter.discover({ since: cutoff });
    expect(ids).not.toContain("wsg_old-agent");
    expect(ids).toContain("wsg_new-agent");
  });
});

// ── metadata ──────────────────────────────────────────────────────────────────

describe("adapter metadata", () => {
  it("has correct name, runtimeVersion, and transcriptKind", () => {
    expect(adapter.name).toBe("windsurf");
    expect(adapter.runtimeVersion).toBe("windsurf/1.0");
    expect(adapter.transcriptKind).toBe("windsurf-sqlite");
  });
});
