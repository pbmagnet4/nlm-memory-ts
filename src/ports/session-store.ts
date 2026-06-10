/**
 * SessionStore — the only way core/ reads or writes the session corpus.
 *
 * Implementations live in core/storage. Adapters and use cases depend on this
 * interface, never on better-sqlite3 directly. Swapping SQLite for Postgres
 * tomorrow means writing a new implementation; core/ does not change.
 */

import type { Session, SessionStatus } from "@shared/types.js";

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

/**
 * Search-time supersedence handling. Replaced sessions (mechanical re-ingest
 * noise) are always excluded. When `includeSuperseded` is true, operator-
 * asserted superseded sessions are kept in the candidate set so investigative
 * recall can surface them down-ranked; when false (default), they are excluded.
 */
export interface SearchOptions {
  readonly includeSuperseded?: boolean;
}

export interface SessionStore {
  list(filter?: SessionFilter): Promise<ReadonlyArray<Session>>;

  getById(sessionId: string): Promise<Session | null>;

  getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>>;

  semanticSearch(
    queryVector: Float32Array,
    limit: number,
    opts?: SearchOptions,
  ): Promise<ReadonlyArray<SemanticNeighbor>>;

  keywordSearch(
    query: string,
    limit: number,
    opts?: SearchOptions,
  ): Promise<ReadonlyArray<KeywordNeighbor>>;

  /**
   * For each id that is a superseded session, return its successor session id
   * (the `from_session` of the `supersedes` edge pointing at it). Ids with no
   * supersedes edge are absent from the map. Cheap edge-only lookup — does not
   * load session bodies. Used at recall result-assembly to badge superseded
   * hits with their successor.
   */
  resolveSuccessors(ids: ReadonlyArray<string>): Promise<Map<string, string>>;

  updateStatus(sessionId: string, status: SessionStatus): Promise<void>;

  /**
   * Mark `predecessorId` as superseded by `successorId`. Atomic:
   *   1. inserts a `session_edges (successorId, predecessorId, 'supersedes')` row
   *   2. flips predecessor's `sessions.status` to `'superseded'`
   *
   * Idempotent — re-marking is a no-op. Throws if either session id is
   * unknown. Used by the `mark_superseded` MCP tool and any future UI
   * action that lets an operator retroactively retire a stale session.
   */
  markSuperseded(predecessorId: string, successorId: string): Promise<void>;
}
