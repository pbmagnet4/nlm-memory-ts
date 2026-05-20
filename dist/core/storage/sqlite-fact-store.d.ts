/**
 * SqliteFactStore — the canonical FactStore implementation, sharing the same
 * better-sqlite3 connection as SqliteSessionStore so session+facts ingest can
 * commit in one transaction (Section 5 of factstore-design.md).
 *
 * Constructor takes an already-opened, already-migrated Database handle from
 * SqliteSessionStore.rawDb(). It does not open its own connection. This is
 * the only way to get a single-writer SQLite to behave atomically across
 * both stores without WAL ordering surprises.
 *
 * Surface evolution:
 *   B.1 — insert, getById, findCurrent, list, listBySession, markSuperseded
 *   B.2 — insertManyInTxn (atomic session+facts ingest), embedding write helper
 *   B.3 — listForRecall (pre-filter for FactRecallService), semanticSearch,
 *         getHistory (supersedence chain inspection)
 *   B.4 — auto-supersedence on (subject, predicate) collision (deferred)
 */
import type Database from "better-sqlite3";
import type { FactListFilter, FactQuery, FactSemanticNeighbor, FactStore } from "../../ports/fact-store.js";
import type { Fact, FactHistoryChain } from "../../shared/types.js";
export declare class SqliteFactStore implements FactStore {
    private readonly db;
    constructor(db: Database.Database);
    insert(fact: Fact): Promise<void>;
    insertMany(facts: ReadonlyArray<Fact>): Promise<void>;
    /**
     * Insert facts inside an already-open transaction (no own txn opened).
     * Callable only from code that has already begun a transaction on the same
     * connection — currently SqliteSessionStore.insertSession. Phase B.2: this
     * is how session+facts ingest commits atomically (Section 5 of the plan).
     */
    insertManyInTxn(facts: ReadonlyArray<Fact>): void;
    getById(id: string): Promise<Fact | null>;
    findCurrent(subject: string, predicate: string): Promise<Fact | null>;
    list(query: FactQuery): Promise<ReadonlyArray<Fact>>;
    listBySession(sessionId: string): Promise<ReadonlyArray<Fact>>;
    listForRecall(filter: FactListFilter): Promise<ReadonlyArray<Fact>>;
    semanticSearch(queryVector: Float32Array, limit: number): Promise<ReadonlyArray<FactSemanticNeighbor>>;
    getHistory(subject: string, predicate?: string): Promise<ReadonlyArray<FactHistoryChain>>;
    /**
     * Insert (or replace) the embedding row for a fact. Best-effort: callers
     * trap embedder errors so an unreachable Ollama doesn't roll back ingest.
     * vec0 doesn't UPDATE, so this is a DELETE+INSERT pair.
     */
    upsertEmbedding(factId: string, vector: Float32Array): void;
    markSuperseded(oldId: string, newId: string | null): Promise<void>;
    private insertStmt;
    private toRow;
    private rowToFact;
}
