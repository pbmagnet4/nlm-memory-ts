/**
 * Backend-agnostic contract test for the FactStore port.
 *
 * Each adapter integration test imports runFactStoreContract and supplies a
 * harness that builds a fresh, migrated, empty Storage instance per test.
 * Identical assertions run against every backend — that is the only proof
 * that a new adapter (e.g. Postgres) is behaviorally equivalent to SQLite.
 *
 * Do NOT put module-level describe() blocks here. The function shape lets
 * each integration test file own its own describe naming.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

export interface FactStoreContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
}

export function runFactStoreContract(h: FactStoreContractHarness): void {
  describe(`FactStore contract — ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await h.setup();
      await storage.withTransaction(async (ctx) => {
        await ctx.sessions.insert(makeSession({ id: "sess_parent", label: "Parent" }));
      });
    });

    afterEach(async () => {
      await h.teardown(storage);
    });

    // BEHAVIOR PORTS — added in Task 3 Step 4 (after Storage port + SqliteStorage exist).
  });
}
