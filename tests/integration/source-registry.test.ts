/**
 * Phase 0 — SourceRegistry integration. Real SQLite, migrations apply,
 * seed defaults, CRUD round-trip, name uniqueness.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { SourceRegistry } from "../../src/core/sources/source-registry.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SourceRegistry", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let registry: SourceRegistry;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-sources-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    registry = new SourceRegistry(storage.rawDb());
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("starts empty and seeds nine presets", () => {
    expect(registry.list()).toEqual([]);
    registry.seedDefaults();
    const rows = registry.list();
    expect(rows.map((r) => r.kind)).toEqual([
      "claude-code", "codex", "hermes", "hermes-agent", "aider", "cursor", "windsurf", "opencode", "pi",
    ]);
    expect(rows.every((r) => r.runtimeLabel.endsWith("/1.0"))).toBe(true);
  });

  it("seedDefaults is idempotent", () => {
    registry.seedDefaults();
    registry.seedDefaults();
    expect(registry.list().length).toBe(9);
  });

  it("inserts a custom JSONL source and round-trips parse config", () => {
    const inserted = registry.insert({
      kind: "jsonl-generic",
      name: "Cursor",
      pathOrUrl: "/tmp/cursor",
      runtimeLabel: "cursor/0.1",
      parseConfig: { sessionIdField: "id", textField: "content" },
    });
    expect(inserted.id).toBeGreaterThan(0);
    const fetched = registry.get(inserted.id);
    expect(fetched?.parseConfig).toEqual({ sessionIdField: "id", textField: "content" });
  });

  it("rejects duplicate names at the unique-constraint level", () => {
    registry.insert({ kind: "webhook", name: "Push", runtimeLabel: "push/1" });
    expect(() => registry.insert({ kind: "webhook", name: "Push", runtimeLabel: "push/2" }))
      .toThrow();
  });

  it("update patches only the supplied fields", () => {
    const row = registry.insert({ kind: "webhook", name: "API", runtimeLabel: "api/1" });
    const updated = registry.update(row.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(updated?.runtimeLabel).toBe("api/1");
  });

  it("delete removes the row", () => {
    const row = registry.insert({ kind: "webhook", name: "Tmp", runtimeLabel: "tmp/1" });
    expect(registry.delete(row.id)).toBe(true);
    expect(registry.get(row.id)).toBeNull();
  });

  it("mints a token on insert for webhook sources, redacts on list/get", () => {
    const row = registry.insert({ kind: "webhook", name: "Tool A", runtimeLabel: "tool-a/1" });
    expect(row.token).toMatch(/^nlm_[a-f0-9]{48}$/);
    expect(row.hasToken).toBe(true);
    const listed = registry.list().find((r) => r.id === row.id);
    expect(listed?.token).toBeNull();
    expect(listed?.hasToken).toBe(true);
    expect(registry.get(row.id)?.token).toBeNull();
  });

  it("findByToken resolves to the owning source", () => {
    const row = registry.insert({ kind: "webhook", name: "Tool B", runtimeLabel: "tool-b/1" });
    expect(row.token).toBeTruthy();
    const found = registry.findByToken(row.token!);
    expect(found?.id).toBe(row.id);
    expect(registry.findByToken("nlm_invalid")).toBeNull();
    expect(registry.findByToken("")).toBeNull();
  });

  it("non-webhook sources do not get tokens", () => {
    const row = registry.insert({
      kind: "jsonl-generic", name: "Logs", runtimeLabel: "logs/1", pathOrUrl: "/tmp/logs",
    });
    expect(row.token).toBeNull();
    expect(row.hasToken).toBe(false);
  });

  it("regenerateToken issues a new token only for webhook sources", () => {
    const wh = registry.insert({ kind: "webhook", name: "Tool C", runtimeLabel: "tool-c/1" });
    const first = wh.token!;
    const second = registry.regenerateToken(wh.id)!;
    expect(second).not.toBe(first);
    expect(registry.findByToken(first)).toBeNull();
    expect(registry.findByToken(second)?.id).toBe(wh.id);

    const jsonl = registry.insert({
      kind: "jsonl-generic", name: "L2", runtimeLabel: "l/1", pathOrUrl: "/tmp/x",
    });
    expect(registry.regenerateToken(jsonl.id)).toBeNull();
  });
});
