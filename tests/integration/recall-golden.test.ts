/**
 * Recall-quality regression gate. A fixed corpus + query/expectation pairs,
 * run through RecallService against a real SqliteSessionStore. Assertions are
 * tolerant (expected session within top 3) so they survive the swap from the
 * token-overlap scorer to FTS5 BM25 ranking. This test must stay green from
 * the current code through every task in this plan.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";
import { GOLDEN_CORPUS, GOLDEN_QUERIES } from "../fixtures/golden-corpus.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

// Keyword-only recall must never touch the embedder; this stub proves it.
class UnreachableEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> {
    throw new LLMUnreachableError("ollama");
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

describe("golden recall regression gate", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteStorage["sessions"];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-golden-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
    for (const session of GOLDEN_CORPUS) {
      store.insertSessionForTest(session);
    }
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const { query, expectTop3 } of GOLDEN_QUERIES) {
    it(`keyword recall surfaces "${expectTop3}" in the top 3 for "${query}"`, async () => {
      const svc = new RecallService({ store, llm: new UnreachableEmbedder() });
      const result = await svc.search({ query, mode: "keyword", limit: 10 });
      const top3 = result.results.slice(0, 3).map((r) => r.id);
      expect(top3).toContain(expectTop3);
    });
  }
});
