import { describe } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runStorageContract } from "../../tests/contract/storage.contract.js";
import type { StorageContractHarness } from "../../tests/contract/storage.contract.js";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import type { Session } from "../../src/shared/types.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

const harness: StorageContractHarness = {
  name: "PgStorage",
  async setup(): Promise<Storage> {
    if (!PG_TEST_URL) throw new Error("NLM_PG_TEST_URL not set");
    const storage = PgStorage.create({
      connectionString: PG_TEST_URL,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    await storage.pgPool().query(TRUNCATE_SQL);
    return storage;
  },
  async teardown(storage: Storage): Promise<void> {
    await storage.close();
  },
  async seedSession(storage: Storage, session: Session): Promise<void> {
    await (storage as PgStorage).sessions.insertSessionForTest(session);
  },
};

describe.skipIf(!PG_TEST_URL)(
  "PgStorage: storage contract",
  () => {
    runStorageContract(harness);
  },
);
