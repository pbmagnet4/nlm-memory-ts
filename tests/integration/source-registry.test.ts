/**
 * Phase 0 — SourceRegistry integration. Real SQLite, migrations apply,
 * seed defaults, CRUD round-trip, name uniqueness.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SourceRegistry } from "../../src/core/sources/source-registry.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SourceRegistry", () => {
  let tmp: string;
  let store: SqliteSessionStore;
  let registry: SourceRegistry;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nle-sources-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    registry = new SourceRegistry(store.rawDb());
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("starts empty and seeds three presets", () => {
    expect(registry.list()).toEqual([]);
    registry.seedDefaults();
    const rows = registry.list();
    expect(rows.map((r) => r.kind)).toEqual(["claude-code", "hermes", "pi"]);
    expect(rows.every((r) => r.runtimeLabel.endsWith("/1.0"))).toBe(true);
  });

  it("seedDefaults is idempotent", () => {
    registry.seedDefaults();
    registry.seedDefaults();
    expect(registry.list().length).toBe(3);
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
});
