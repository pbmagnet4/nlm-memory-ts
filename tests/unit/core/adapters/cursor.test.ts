/**
 * CursorAdapter unit tests.
 *
 * Each test builds an in-memory SQLite DB seeded with the cursorDiskKV
 * key-value schema Cursor uses, writes it to a temp file so the adapter
 * can open it with better-sqlite3 in readonly mode.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorAdapter } from "../../../../src/core/adapters/cursor.js";

// ── Schema helpers ────────────────────────────────────────────────────────────

function createDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cursorDiskKV (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

function addComposerInline(
  db: Database.Database,
  composerId: string,
  opts: {
    name?: string;
    createdAt?: string;
    lastUpdatedAt?: string;
    conversation?: Array<{ type: number; text: string }>;
  } = {},
): void {
  const data = {
    composerId,
    name: opts.name ?? "Test session",
    createdAt: opts.createdAt ?? new Date(Date.now() - 3600_000).toISOString(),
    lastUpdatedAt: opts.lastUpdatedAt ?? new Date().toISOString(),
    conversation: opts.conversation ?? [],
  };
  db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
    `composerData:${composerId}`,
    JSON.stringify(data),
  );
}

function addBubble(
  db: Database.Database,
  composerId: string,
  bubbleId: string,
  type: 1 | 2,
  text: string,
): void {
  const data = { type, text };
  db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
    `bubbleId:${composerId}:${bubbleId}`,
    JSON.stringify(data),
  );
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmp: string;
let dbPath: string;
let adapter: CursorAdapter;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-cursor-"));
  dbPath = join(tmp, "state.vscdb");
  adapter = new CursorAdapter({ dbPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── detect() ─────────────────────────────────────────────────────────────────

describe("detect()", () => {
  it("returns enabled when DB exists", () => {
    const db = createDb(dbPath);
    db.close();
    const result = adapter.detect();
    expect(result.enabled).toBe(true);
    expect(result.path).toBe(dbPath);
    expect(result.hint).toBeNull();
  });

  it("returns disabled when DB is absent", () => {
    const result = adapter.detect();
    expect(result.enabled).toBe(false);
    expect(result.path).toBeNull();
    expect(result.hint).toMatch(/Cursor/);
  });
});

// ── discover() ───────────────────────────────────────────────────────────────

describe("discover()", () => {
  it("returns empty array when DB is absent", async () => {
    expect(await adapter.discover()).toEqual([]);
  });

  it("returns composerIds for all composer entries", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "composer-aaa");
    addComposerInline(db, "composer-bbb");
    db.close();

    const ids = await adapter.discover();
    expect(ids).toEqual(["composer-aaa", "composer-bbb"]);
  });

  it("returns empty array when DB has no cursorDiskKV table", async () => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE ItemTable (key TEXT, value TEXT);`);
    db.close();
    expect(await adapter.discover()).toEqual([]);
  });

  it("skips entries whose value is not valid JSON", async () => {
    const db = createDb(dbPath);
    db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
      "composerData:broken",
      "not-json",
    );
    addComposerInline(db, "composer-good");
    db.close();

    const ids = await adapter.discover();
    expect(ids).toEqual(["composer-good"]);
  });

  it("filters by since when lastUpdatedAt is set", async () => {
    const db = createDb(dbPath);
    const old = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
    const recent = new Date().toISOString();
    addComposerInline(db, "old-composer", { lastUpdatedAt: old });
    addComposerInline(db, "new-composer", { lastUpdatedAt: recent });
    db.close();

    const cutoff = new Date(Date.now() - 5 * 24 * 3600_000);
    const ids = await adapter.discover({ since: cutoff });
    expect(ids).toEqual(["new-composer"]);
  });
});

// ── parseSession() ────────────────────────────────────────────────────────────

describe("parseSession()", () => {
  it("returns null when DB is absent", async () => {
    expect(await adapter.parseSession("any-id")).toBeNull();
  });

  it("returns null for unknown composerId", async () => {
    const db = createDb(dbPath);
    db.close();
    expect(await adapter.parseSession("ghost-id")).toBeNull();
  });

  it("returns null for composer with no turns", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "empty-id", { conversation: [] });
    db.close();
    expect(await adapter.parseSession("empty-id")).toBeNull();
  });

  it("extracts turns from inline conversation[]", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "inline-id", {
      name: "My session",
      conversation: [
        { type: 1, text: "Hello" },
        { type: 2, text: "Hi there" },
      ],
    });
    db.close();

    const chunk = await adapter.parseSession("inline-id");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(2);
    expect(chunk!.text).toContain("user: Hello");
    expect(chunk!.text).toContain("assistant: Hi there");
  });

  it("falls back to bubbleId:* separate storage when conversation is empty", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "sep-id", { conversation: [] });
    addBubble(db, "sep-id", "b1", 1, "What is 2+2?");
    addBubble(db, "sep-id", "b2", 2, "It is 4.");
    db.close();

    const chunk = await adapter.parseSession("sep-id");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(2);
    expect(chunk!.text).toContain("user: What is 2+2?");
    expect(chunk!.text).toContain("assistant: It is 4.");
  });

  it("uses composer name as label", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "named-id", {
      name: "Refactor the auth module",
      conversation: [{ type: 1, text: "Let's refactor" }],
    });
    db.close();

    const chunk = await adapter.parseSession("named-id");
    expect(chunk!.label).toBe("Refactor the auth module");
  });

  it("falls back to first user turn as label when name is absent", async () => {
    const db = createDb(dbPath);
    const data = {
      composerId: "unlabeled-id",
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      conversation: [
        { type: 1, text: "Tell me about TypeScript generics" },
        { type: 2, text: "Generics allow..." },
      ],
    };
    db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
      "composerData:unlabeled-id",
      JSON.stringify(data),
    );
    db.close();

    const chunk = await adapter.parseSession("unlabeled-id");
    expect(chunk!.label).toBe("Tell me about TypeScript generics");
  });

  it("sets correct id prefix and runtimeSessionId", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "id-check", {
      conversation: [{ type: 1, text: "Hello" }],
    });
    db.close();

    const chunk = await adapter.parseSession("id-check");
    expect(chunk!.runtimeSessionId).toBe("id-check");
    expect(chunk!.id).toMatch(/^cr_/);
  });

  it("sets sourcePath to dbPath::composerId", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "path-check", {
      conversation: [{ type: 1, text: "Hello" }],
    });
    db.close();

    const chunk = await adapter.parseSession("path-check");
    expect(chunk!.sourcePath).toBe(`${dbPath}::path-check`);
  });

  it("skips bubbles with empty text", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "sparse-id", {
      conversation: [
        { type: 1, text: "" },
        { type: 1, text: "Real question" },
        { type: 2, text: "Real answer" },
      ],
    });
    db.close();

    const chunk = await adapter.parseSession("sparse-id");
    expect(chunk!.turnCount).toBe(2);
  });

  it("skips bubbles with unknown type", async () => {
    const db = createDb(dbPath);
    const data = {
      composerId: "typed-id",
      conversation: [
        { type: 99, text: "system message" },
        { type: 1, text: "user question" },
        { type: 2, text: "assistant answer" },
      ],
    };
    db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
      "composerData:typed-id",
      JSON.stringify(data),
    );
    db.close();

    const chunk = await adapter.parseSession("typed-id");
    expect(chunk!.turnCount).toBe(2);
  });

  it("populates byteRange[1] equal to transcript byte length", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "bytes-id", {
      conversation: [
        { type: 1, text: "Hello" },
        { type: 2, text: "Hi" },
      ],
    });
    db.close();

    const chunk = await adapter.parseSession("bytes-id");
    const expected = Buffer.byteLength(chunk!.text, "utf8");
    expect(chunk!.byteRange[1]).toBe(expected);
  });
});

// ── metadata ──────────────────────────────────────────────────────────────────

describe("adapter metadata", () => {
  it("has correct name, runtimeVersion, and transcriptKind", () => {
    expect(adapter.name).toBe("cursor");
    expect(adapter.runtimeVersion).toBe("cursor/1.0");
    expect(adapter.transcriptKind).toBe("cursor-sqlite");
  });
});
