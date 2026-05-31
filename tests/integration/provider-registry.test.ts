/**
 * Phase 0 task 3 — ProviderRegistry integration. Real SQLite, seed
 * defaults bridge from env, CRUD, secret redaction on list/get.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { ProviderRegistry } from "../../src/core/providers/provider-registry.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("ProviderRegistry", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let registry: ProviderRegistry;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-providers-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    registry = new ProviderRegistry(storage.rawDb());
    savedKey = process.env["DEEPSEEK_API_KEY"];
  });

  afterEach(async () => {
    if (savedKey === undefined) delete process.env["DEEPSEEK_API_KEY"];
    else process.env["DEEPSEEK_API_KEY"] = savedKey;
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("seedDefaults inserts Ollama always, DeepSeek with key when present", () => {
    process.env["DEEPSEEK_API_KEY"] = "sk-test-abc";
    registry.seedDefaults();
    const rows = registry.list();
    expect(rows.map((r) => r.kind)).toEqual(["ollama", "deepseek"]);
    const deepseek = rows.find((r) => r.kind === "deepseek");
    expect(deepseek?.enabled).toBe(true);
    expect(deepseek?.hasApiKey).toBe(true);
    expect(deepseek?.apiKey).toBeNull(); // redacted
  });

  it("seedDefaults disables DeepSeek when key is absent", () => {
    delete process.env["DEEPSEEK_API_KEY"];
    registry.seedDefaults();
    const deepseek = registry.getByName("DeepSeek");
    expect(deepseek?.enabled).toBe(false);
    expect(deepseek?.hasApiKey).toBe(false);
  });

  it("seedDefaults is idempotent", () => {
    registry.seedDefaults();
    registry.seedDefaults();
    expect(registry.list().length).toBe(2);
  });

  it("inserts a custom provider with explicit base URL", () => {
    const row = registry.insert({
      kind: "openai-compatible",
      name: "vLLM box",
      baseUrl: "http://192.168.1.50:8000/v1",
      defaultModel: "llama-3.1-70b",
      apiKey: "secret-token",
    });
    expect(row.baseUrl).toBe("http://192.168.1.50:8000/v1");
    expect(row.hasApiKey).toBe(true);
    expect(row.apiKey).toBeNull();
  });

  it("getSecret returns the unredacted key", () => {
    const row = registry.insert({
      kind: "openai", name: "OpenAI prod", apiKey: "sk-real",
    });
    expect(registry.getSecret(row.id)).toBe("sk-real");
  });

  it("rejects duplicate names", () => {
    registry.insert({ kind: "openai", name: "OpenAI", apiKey: "k" });
    expect(() => registry.insert({ kind: "openai", name: "OpenAI", apiKey: "k2" }))
      .toThrow();
  });

  it("update patches only supplied fields", () => {
    const row = registry.insert({ kind: "openai", name: "OAI", apiKey: "k1" });
    const updated = registry.update(row.id, { apiKey: "k2", enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(registry.getSecret(row.id)).toBe("k2");
  });

  it("delete removes the row", () => {
    const row = registry.insert({ kind: "openai", name: "Tmp", apiKey: "k" });
    expect(registry.delete(row.id)).toBe(true);
    expect(registry.get(row.id)).toBeNull();
  });

  it("fills in default base URL and model when omitted", () => {
    const row = registry.insert({ kind: "anthropic", name: "Claude", apiKey: "k" });
    expect(row.baseUrl).toBe("https://api.anthropic.com");
    expect(row.defaultModel).toBe("claude-haiku-4-5-20251001");
  });
});
