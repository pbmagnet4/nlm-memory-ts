/**
 * SessionStore — the only way core/ reads or writes the session corpus.
 *
 * Implementations live in core/storage. Adapters and use cases depend on this
 * interface, never on better-sqlite3 directly. Swapping SQLite for Postgres
 * tomorrow means writing a new implementation; core/ does not change.
 */
import type { Session, SessionStatus } from "../shared/types.js";
export interface SessionFilter {
    readonly entity?: string;
    readonly hasDecisions?: boolean;
    readonly hasOpenQuestions?: boolean;
}
export interface SemanticNeighbor {
    readonly sessionId: string;
    readonly distance: number;
}
export interface KeywordNeighbor {
    readonly sessionId: string;
    readonly score: number;
}
export interface SessionStore {
    list(filter?: SessionFilter): Promise<ReadonlyArray<Session>>;
    getById(sessionId: string): Promise<Session | null>;
    getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>>;
    semanticSearch(queryVector: Float32Array, limit: number): Promise<ReadonlyArray<SemanticNeighbor>>;
    keywordSearch(query: string, limit: number): Promise<ReadonlyArray<KeywordNeighbor>>;
    updateStatus(sessionId: string, status: SessionStatus): Promise<void>;
}
