/**
 * Shared domain types crossed by core, http, mcp, and ui layers.
 * No runtime behavior here — types only.
 */

/**
 * Session status as exposed to UI / recall consumers.
 *
 * Persisted values in `sessions.status` CHECK: 'active' | 'closed' |
 * 'superseded' | 'replaced'. `idle` is a derived state computed from
 * transcript mtime, returned by the storage layer alongside the persisted
 * value. `superseded`/`replaced` always win over mtime-derived state.
 *
 * `superseded` = operator-asserted epistemic overturn (markSuperseded).
 * `replaced` = mechanical re-ingest of a grown transcript (supersede-on-resume);
 * the predecessor is a strict subset of the successor. See
 * docs/plans/2026-06-10-supersedence-split.md.
 */
export type SessionStatus = "active" | "idle" | "closed" | "superseded" | "replaced";

export interface Session {
  readonly id: string;
  readonly runtime: string;
  readonly runtimeSessionId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMin: number | null;
  readonly label: string;
  readonly summary: string;
  readonly status: SessionStatus;
  readonly transcriptKind: string;
  readonly transcriptPath: string | null;
  readonly body: string;
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
  /** IDs of sessions this session supersedes (newer → older). Populated by getById; absent on bulk reads. */
  readonly supersedes?: ReadonlyArray<string>;
  /** ID of the session that superseded this one, if any. Populated by getById; absent on bulk reads. */
  readonly supersededBy?: string | null;
}

/**
 * Supersedence-relation edge kinds in `session_edges.kind`.
 *
 * `supersedes` = operator-asserted overturn (markSuperseded); paired with
 * predecessor status `superseded`. `replaces` = mechanical re-ingest of a
 * grown transcript; paired with predecessor status `replaced`. Both are
 * traversed together for cycle detection and the supersedence graph; only
 * `supersedes` counts toward the provenance-integrity KPI. See
 * docs/plans/2026-06-10-supersedence-split.md.
 *
 * `session_edges` also stores `continues` (and the schema CHECK permits
 * `branched_from`/`merged_from`); those are not supersedence relations.
 */
export type SessionEdgeKind = "supersedes" | "replaces";

export type RecallMode = "keyword" | "semantic" | "hybrid";

export type RecallKindFilter = "decision" | "open";

export interface RecallQuery {
  readonly query: string;
  readonly entity?: string;
  readonly kind?: RecallKindFilter;
  readonly mode?: RecallMode;
  readonly limit?: number;
  /**
   * If true, RecallService runs an LLM rewrite pass on the query before
   * keyword/semantic search — useful for vague natural-language queries.
   * Falls back to the raw query on LLM errors. Adds ~hundreds of ms.
   * Off by default; MCP `recall_sessions` tool defaults to true since
   * callers there have already committed to a memory search. Hot-path
   * callers (hooks) pass false; the HTTP handler force-overrides to false
   * when the `x-recall-source: hook` header is present.
   */
  readonly rewrite?: boolean;
  /**
   * If true, RecallService attaches a `relatedFacts` array of current
   * high-confidence facts about the entities in the top hits. Defaults
   * to true for the HTTP hook caller (so the pointer block can include
   * structured context); other callers must opt in. Disable globally
   * via NLM_HOOK_INJECT_FACTS=false. Spec G.2.
   */
  readonly withRelatedFacts?: boolean;
  /**
   * If true, superseded sessions are included in recall results, down-ranked
   * and carrying a `supersededBy` pointer to their successor. Replaced
   * sessions (mechanical re-ingest noise) are excluded regardless. Off by
   * default — the hot-path hooks rely on strict exclusion. Investigative
   * surfaces (CLI `nlm recall`, MCP `recall_sessions`) set this true so a user
   * chasing a decision sees the overturned session badged with its successor.
   * Task #303.
   */
  readonly includeSuperseded?: boolean;
}

export interface RecallHit {
  readonly id: string;
  readonly startedAt: string;
  readonly label: string;
  readonly summary: string;
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
  readonly status: SessionStatus;
  readonly matchScore: number;
  readonly matchedIn: ReadonlyArray<MatchField>;
  readonly keywordScore?: number;
  readonly semanticScore?: number;
  /**
   * Successor session id when this hit's `status` is `superseded`; null when
   * the hit is active. Lets a consumer point at the corrected reasoning
   * without a second round-trip. Task #303.
   */
  readonly supersededBy: string | null;
}

export type MatchField = "label" | "decisions" | "open" | "summary" | "semantic";

export interface RecallResult {
  readonly query: string;
  readonly entity: string | null;
  readonly kind: RecallKindFilter | null;
  readonly mode: RecallMode;
  readonly limit: number;
  readonly total: number;
  readonly results: ReadonlyArray<RecallHit>;
  readonly modeUnavailable?: "ollama_unreachable";
  /**
   * Spec G.2: optional set of current high-confidence facts about the
   * entities in the top hits. Present only when the caller requested
   * `withRelatedFacts`. The pointer-block formatter renders these as a
   * "Known facts" section beneath the session pointer list.
   */
  readonly relatedFacts?: ReadonlyArray<RelatedFact>;
}

/**
 * Fact — a single normalized claim derived from a session.
 *
 * The product treats sessions as the unit of operator recall. Facts are the
 * agent-facing projection: queryable by (subject, predicate), supersedence-
 * aware, with provenance back to the session they came from. See
 * docs/plans/factstore-design.md for the full design rationale.
 *
 * `kind` mirrors the marker taxonomy plus a third category for entity
 * attributes ("mac-pro-llm-host" + "endpoint" + "http://macpro:8080/v1").
 *
 * `subject` and `predicate` are normalized (lowercased, trimmed) at extraction
 * time so the deterministic supersedence path can do exact-match collision
 * detection without per-query normalization.
 *
 * `supersededBy` is a tombstone pointer — when a newer fact replaces this one
 * the old row stays and gets pointed at the new id. Never deleted.
 */
export type FactKind = "decision" | "open" | "attribute";

export interface Fact {
  readonly id: string;
  readonly kind: FactKind;
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly sourceSessionId: string;
  readonly sourceQuote: string | null;
  readonly createdAt: string;
  readonly supersededBy: string | null;
  readonly confidence: number;
}

export type FactMatchField = "value" | "subject" | "predicate" | "semantic";

export interface FactRecallQuery {
  readonly query?: string;
  readonly subject?: string;
  readonly predicate?: string;
  readonly kind?: FactKind;
  readonly includeSuperseded?: boolean;
  readonly minConfidence?: number;
  readonly mode?: RecallMode;
  readonly limit?: number;
}

export interface FactHit extends Fact {
  readonly matchScore: number;
  readonly matchedIn: ReadonlyArray<FactMatchField>;
  readonly keywordScore?: number;
  readonly semanticScore?: number;
  /**
   * Number of distinct sessions across the full fact history that asserted
   * this exact (subject, predicate, value). >1 means corroborated; the
   * recall service applies a log-scale boost to matchScore based on this
   * count. Capped boost via NLM_FACT_CORROBORATION_BOOST_CAP.
   */
  readonly corroborationCount?: number;
}

export interface FactRecallResult {
  readonly query: string;
  readonly subject: string | null;
  readonly predicate: string | null;
  readonly kind: FactKind | null;
  readonly mode: RecallMode;
  readonly limit: number;
  readonly total: number;
  readonly results: ReadonlyArray<FactHit>;
  readonly modeUnavailable?: "ollama_unreachable";
}

/**
 * A current high-confidence fact attached to a recall result — the hook
 * uses these to inject structured context ("polysignal uses: duckdb")
 * alongside the session pointer list. Selected by `pickRelatedFacts`
 * server-side using the entities of the top recall hits, the fact-store
 * confidence filter, and the spec G.1 corroborationCount.
 */
export interface RelatedFact {
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly corroborationCount: number;
}

export interface FactHistoryChain {
  readonly subject: string;
  readonly predicate: string;
  readonly history: ReadonlyArray<Fact>;
}

// ── Signals (agent self-improvement lane) ──────────────────────────────────
//
// A distinct store kind from facts: structured quality/eval telemetry emitted
// by harnesses (the Pi quality gate is the reference producer). Append-only,
// idempotent on a deterministic id, no supersedence, no embeddings. See
// docs/superpowers/specs/2026-06-09-agent-self-improvement-signals.md.

export type SignalKind = "gate" | "eval" | "review" | "test";
export type SignalOutcome = "pass" | "fail" | "fix" | "exhausted";

/** Producer-side payload. `install_scope` and `id` are stamped server-side. */
export interface SignalInput {
  readonly v?: number;
  readonly kind: SignalKind;
  readonly producer: string;
  readonly outcome: SignalOutcome;
  readonly model: string;
  readonly repo: string;
  readonly step: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly session: string | null;
  readonly ts: string;
}

/** Stored signal. `step` is denormalized from `detail.step` for indexing. */
export interface Signal {
  readonly id: string;
  readonly v: number;
  readonly installScope: string;
  readonly kind: SignalKind;
  readonly producer: string;
  readonly outcome: SignalOutcome;
  readonly model: string;
  readonly repo: string;
  readonly step: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly sessionId: string | null;
  readonly ts: string;
  readonly createdAt: string;
}
