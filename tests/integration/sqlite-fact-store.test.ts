/**
 * SqliteFactStore conformance to the FactStore port contract.
 *
 * The actual assertions live in tests/contract/fact-store.contract.ts so
 * the Postgres adapter (#216-218) can run them unchanged.
 *
 * SQLite-specific assertions that poke rawDb() for internal state live in
 * tests/integration/sqlite-fact-store.internal.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Storage } from "../../src/ports/storage.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { runFactStoreContract } from "../contract/fact-store.contract.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const tmpDirs = new WeakMap<Storage, string>();

runFactStoreContract({
  name: "sqlite",
  async setup() {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-facts-"));
    const storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    tmpDirs.set(storage, tmp);
    return storage;
  },
  async teardown(storage) {
    const tmp = tmpDirs.get(storage);
    await storage.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  },
  async seedSession(storage, session) {
    (storage as SqliteStorage).sessions.insertSessionForTest(session);
  },
});
