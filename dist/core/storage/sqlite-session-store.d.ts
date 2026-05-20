/**
 * SqliteSessionStore — the canonical SessionStore implementation backed by
 * better-sqlite3 with the sqlite-vec extension loaded for KNN search.
 *
 * Layering note: core/ imports this concrete class only at the composition
 * root (CLI / server bootstrap). The recall use case and every other piece
 * of core depends on the SessionStore *port*, never on this file.
 *
 * Schema parity with the Python daemon: sessions row + session_entities +
 * markers + session_embeddings (vec0). Idle-status overlay (computed from
 * transcript mtime) is deferred to a later phase — A.2 returns the persisted
 * status verbatim.
 */
import Database from "better-sqlite3";
import type { KeywordNeighbor, SemanticNeighbor, SessionFilter, SessionStore } from "../../ports/session-store.js";
import type { Session, SessionStatus } from "../../shared/types.js";
import type { Fact } from "../../shared/types.js";
import type { SqliteFactStore } from "./sqlite-fact-store.js";
export interface SqliteSessionStoreOptions {
    readonly dbPath: string;
    readonly migrationsDir: string;
    readonly readonly?: boolean;
}
/** Full ingest payload for SqliteSessionStore.insertSession. */
export interface IngestRecord {
    readonly id: string;
    readonly runtime: string;
    readonly runtimeSessionId: string | null;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly durationMin: number | null;
    readonly label: string;
    readonly summary: string;
    readonly body: string | null;
    readonly status: SessionStatus;
    readonly transcriptKind: string | null;
    readonly transcriptPath: string | null;
    readonly transcriptOffset: number | null;
    readonly transcriptLength: number | null;
    readonly entities: ReadonlyArray<string>;
    readonly decisions: ReadonlyArray<string>;
    readonly openQuestions: ReadonlyArray<string>;
}
export interface RecentWrite {
    id: string;
    runtime: string;
    label: string;
    summary: string;
    createdAt: string;
}
export interface RecentMarker {
    sessionId: string;
    kind: "decision" | "open";
    text: string;
    label: string;
    createdAt: string;
}
export declare class SqliteSessionStore implements SessionStore {
    private readonly db;
    constructor(opts: SqliteSessionStoreOptions);
    close(): void;
    /**
     * Drains the WAL into the main database and truncates the -wal file.
     * WAL mode is on but nothing else checkpoints, so the file grows
     * unbounded under continuous readers. The daemon calls this on an
     * interval. Synchronous — keep the WAL small so each call is cheap.
     */
    checkpoint(): void;
    /** Raw db handle for ingest helpers (Scheduler, scanOnce). Avoid using
     *  directly from the recall path — it bypasses the SessionStore port. */
    rawDb(): Database.Database;
    /** Recently-written sessions ordered by created_at desc. Powers /live Writes column. */
    recentWrites(limit: number): RecentWrite[];
    /** Recently-extracted markers ordered by session created_at desc. Powers /live Decisions column. */
    recentMarkers(limit: number): RecentMarker[];
    /**
     * Atomic ingest: writes the session row, markers, entity rows + links,
     * supersedes edge (if any), and the embedding (best-effort) in one
     * transaction. Idempotent on re-ingest — ON CONFLICT updates the session
     * in place; markers are deleted and rewritten; entity links use INSERT OR
     * IGNORE; embedding row is DELETE+INSERT (vec0 doesn't UPDATE).
     *
     * Mirrors Python's SQLiteStore.insert_session. Markdown projection is not
     * yet ported and skipped here.
     */
    insertSession(record: IngestRecord, embedder?: import("../../ports/llm-client.js").LLMClient | null, supersedes?: string | null, factSink?: {
        factStore: SqliteFactStore;
        facts: ReadonlyArray<Fact>;
    } | null): Promise<void>;
    /**
     * Phase B.5 — backfill entry point. Writes facts (with deterministic
     * supersedence + best-effort embeddings) for an EXISTING session row
     * without touching it. Opens its own transaction; callers must not be
     * inside one. The session row must already exist in `sessions` or the
     * FK on facts.source_session_id rejects.
     *
     * Use this when ingesting facts after the fact — e.g. running the
     * classifier across a historical corpus that predates the B.2 ingest
     * write path. The live ingest path (`insertSession`) keeps using the
     * internal helpers directly so session+facts commit together.
     */
    insertFactsForSession(sessionId: string, factStore: SqliteFactStore, facts: ReadonlyArray<Fact>, embedder?: import("../../ports/llm-client.js").LLMClient | null): Promise<void>;
    /**
     * Sync core of the fact-ingest block. Runs inside an EXISTING transaction
     * — opens no txn of its own. Used by both `insertSession` (Phase B.2
     * atomic ingest) and `insertFactsForSession` (Phase B.5 backfill).
     *
     * Behavior (mirrored across both callers):
     *   1. DELETE prior facts attributed to this session (idempotent on
     *      backfill, drops stale rows on re-ingest).
     *   2. Insert all new facts atomically.
     *   3. For each, mark the prior current (subject, predicate) fact as
     *      superseded — Phase B.4 deterministic supersedence policy.
     *
     * Ordering: inserts before updates so the supersedence FK target exists.
     * CASCADE-SET-NULL on `superseded_by` handles chain repair on re-ingest.
     */
    private applyFactsInTxn;
    /**
     * Best-effort per-fact embedding. Writes `${subject} ${predicate} ${value}`
     * embeddings to fact_embeddings via FactStore.upsertEmbedding. Per-fact
     * failures don't abort the batch, and never affect committed fact rows.
     */
    private embedFacts;
    list(filter?: SessionFilter): Promise<ReadonlyArray<Session>>;
    getById(sessionId: string): Promise<Session | null>;
    /**
     * Batched session fetch for the recall path. Deliberately omits the
     * `body` column — body is ~48KB/row of session markdown that recall
     * never reads, and SELECTing it for the corpus is what wedged the
     * daemon. Resolved sessions carry `body: ""`.
     */
    getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>>;
    semanticSearch(queryVector: Float32Array, limit: number): Promise<ReadonlyArray<SemanticNeighbor>>;
    /**
     * Lexical recall via the sessions_fts FTS5 index. BM25 column weights
     * favour label over summary over body. Returns sessions ranked best-first
     * with a positive score (the negated bm25() value — bm25 is more negative
     * for better matches). User input is tokenized and rebuilt into a quoted
     * OR query so FTS5 metacharacters cannot reach the MATCH parser.
     */
    keywordSearch(query: string, limit: number): Promise<ReadonlyArray<KeywordNeighbor>>;
    updateStatus(sessionId: string, status: SessionStatus): Promise<void>;
    insertSessionForTest(session: Session): void;
    insertEmbeddingForTest(sessionId: string, vector: Float32Array): void;
    private loadEntities;
    private loadMarkers;
    private rowToSession;
}
