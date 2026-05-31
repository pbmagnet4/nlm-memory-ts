/**
 * Storage withTransaction contract test.
 *
 * Verifies atomicity: a callback that writes two facts either commits both
 * or rolls back both. Adapter-agnostic — wire any Storage implementation
 * via StorageContractHarness.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

export interface StorageContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
  seedSession(storage: Storage, session: import("../../src/shared/types.js").Session): Promise<void>;
}

export function runStorageContract(h: StorageContractHarness): void {
  describe(`Storage contract: ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await h.setup();
      await h.seedSession(storage, makeSession({ id: "sess_a" }));
      await h.seedSession(storage, makeSession({ id: "sess_b" }));
    });

    afterEach(async () => {
      await h.teardown(storage);
    });

    it("commits both writes when callback succeeds", async () => {
      await storage.withTransaction((ctx) => {
        ctx.facts.ingestSessionFacts("sess_a", [
          makeFact({ id: "f1", subject: "alpha", sourceSessionId: "sess_a" }),
        ]);
        ctx.facts.ingestSessionFacts("sess_b", [
          makeFact({ id: "f2", subject: "beta", sourceSessionId: "sess_b" }),
        ]);
      });
      expect(await storage.facts.getById("f1")).not.toBeNull();
      expect(await storage.facts.getById("f2")).not.toBeNull();
    });

    it("rolls back all writes when callback throws", async () => {
      await storage.facts.insert(
        makeFact({ id: "existing", subject: "pre", sourceSessionId: "sess_a" }),
      );
      await expect(
        storage.withTransaction((ctx) => {
          ctx.facts.ingestSessionFacts("sess_a", [
            makeFact({ id: "new", subject: "alpha", sourceSessionId: "sess_a" }),
          ]);
          throw new Error("deliberate rollback");
        }),
      ).rejects.toThrow("deliberate rollback");
      // "existing" survives; "new" was never committed.
      expect(await storage.facts.getById("existing")).not.toBeNull();
      expect(await storage.facts.getById("new")).toBeNull();
    });

    it("rejects nested withTransaction calls", async () => {
      await expect(
        storage.withTransaction((_outer) => {
          void storage.withTransaction((_inner) => {
            // no-op
          });
        }),
      ).rejects.toThrow(/nesting/i);
    });
  });
}
