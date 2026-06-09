import { describe, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { runSignalStoreContract } from "../contract/signal-store.contract.js";
import { resolve } from "node:path";

const PG_URL = process.env["NLM_TEST_PG_URL"];
const PG_MIGRATIONS_DIR = resolve(__dirname, "../../migrations/pg");

if (!PG_URL) {
  describe.skip("SignalStore contract: pg (NLM_TEST_PG_URL unset)", () => {
    it("skipped", () => {});
  });
} else {
  runSignalStoreContract({
    name: "pg",
    async setup() {
      const storage = PgStorage.create({ connectionString: PG_URL, migrationsDir: PG_MIGRATIONS_DIR });
      await storage.init();
      await (storage as PgStorage).pgPool().query("TRUNCATE signals");
      return storage;
    },
    async teardown(storage) {
      await (storage as PgStorage).pgPool().query("TRUNCATE signals");
      await storage.close();
    },
  });
}
