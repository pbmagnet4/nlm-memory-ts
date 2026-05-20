/**
 * RecallService — the use case. Composes filters, keyword scoring, and
 * semantic search into a single recall operation.
 *
 * Depends only on ports (SessionStore, LLMClient). No framework imports,
 * no SQLite, no HTTP. Tests substitute fake adapters.
 */

import type { LLMClient } from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";
import type {
  KeywordNeighbor,
  SemanticNeighbor,
  SessionStore,
} from "@ports/session-store.js";
import type {
  MatchField,
  RecallHit,
  RecallMode,
  RecallQuery,
  RecallResult,
  Session,
} from "@shared/types.js";
import { applyFilter } from "./filter.js";
import { keywordMatchFields } from "./match-fields.js";
import { tokenSet } from "./tokenize.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const HYBRID_KW_WEIGHT = 0.4;
const HYBRID_SEM_WEIGHT = 0.6;
const SEMANTIC_OVERFETCH = 3;
const KEYWORD_OVERFETCH = 3;

export interface RecallServiceDeps {
  readonly store: SessionStore;
  readonly llm: LLMClient;
}

export class RecallService {
  constructor(private readonly deps: RecallServiceDeps) {}

  async search(input: RecallQuery): Promise<RecallResult> {
    const mode: RecallMode = input.mode ?? "keyword";
    const limit = clampLimit(input.limit);
    const entity = input.entity ?? null;
    const kind = input.kind ?? null;

    const empty: RecallResult = {
      query: input.query,
      entity,
      kind,
      mode,
      limit,
      total: 0,
      results: [],
    };

    if (!input.query && !entity && !kind) return empty;

    // 1. Search legs — ranked neighbor IDs only. No session bodies loaded.
    const kwNeighbors: ReadonlyArray<KeywordNeighbor> =
      (mode === "keyword" || mode === "hybrid") && input.query
        ? await this.deps.store.keywordSearch(input.query, limit * KEYWORD_OVERFETCH)
        : [];

    let semNeighbors: ReadonlyArray<SemanticNeighbor> = [];
    let semError: "ollama_unreachable" | null = null;
    if ((mode === "semantic" || mode === "hybrid") && input.query) {
      try {
        const embedding = await this.deps.llm.embed(input.query, "query");
        semNeighbors = await this.deps.store.semanticSearch(
          embedding.vector,
          limit * SEMANTIC_OVERFETCH,
        );
      } catch (err) {
        if (err instanceof LLMUnreachableError) {
          semError = "ollama_unreachable";
        } else {
          throw err;
        }
      }
    }

    if (mode === "semantic" && semError) {
      return { ...empty, modeUnavailable: semError };
    }

    // 2. Resolve ONLY the hit sessions — never the whole corpus. The
    //    entity/kind filter is applied to the fetched hits; a filtered-out
    //    session is absent from byId and is skipped during resolution.
    const hitIds = uniqueIds(kwNeighbors, semNeighbors);
    const hitSessions = await this.deps.store.getByIds(hitIds);
    const filterArgs: { entity?: string; kind?: typeof input.kind } = {};
    if (input.entity !== undefined) filterArgs.entity = input.entity;
    if (input.kind !== undefined) filterArgs.kind = input.kind;
    const byId = new Map<string, Session>(
      applyFilter(hitSessions, filterArgs).map((s) => [s.id, s]),
    );

    // 3. Build hits from the resolved sessions, preserving leg rank order.
    const queryTokens = input.query
      ? new Set(tokenSet(input.query))
      : new Set<string>();

    const kwHits: KeywordHit[] = [];
    for (const n of kwNeighbors) {
      const session = byId.get(n.sessionId);
      if (!session) continue;
      kwHits.push({
        session,
        score: n.score,
        matchedIn: keywordMatchFields(session, queryTokens),
      });
    }

    const semHits: SemanticHit[] = [];
    for (const n of semNeighbors) {
      const session = byId.get(n.sessionId);
      if (!session) continue;
      semHits.push({ session, similarity: cosineFromL2(n.distance) });
    }

    // 4. Finalize per mode.
    if (mode === "keyword") {
      return finalize(input.query, entity, kind, mode, limit, kwHits.map(toKeywordHit));
    }
    if (mode === "semantic") {
      return finalize(input.query, entity, kind, mode, limit, semHits.map(toSemanticHit));
    }
    const merged = mergeHybrid(kwHits, semHits);
    const result = finalize(input.query, entity, kind, mode, limit, merged);
    return semError ? { ...result, modeUnavailable: semError } : result;
  }
}

function uniqueIds(
  kw: ReadonlyArray<KeywordNeighbor>,
  sem: ReadonlyArray<SemanticNeighbor>,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const n of kw) ids.add(n.sessionId);
  for (const n of sem) ids.add(n.sessionId);
  return [...ids];
}

interface KeywordHit {
  readonly session: Session;
  readonly score: number;
  readonly matchedIn: ReadonlyArray<MatchField>;
}

interface SemanticHit {
  readonly session: Session;
  readonly similarity: number;
}

function mergeHybrid(
  kwHits: ReadonlyArray<KeywordHit>,
  semHits: ReadonlyArray<SemanticHit>,
): ReadonlyArray<RecallHit> {
  const maxKw = Math.max(1, ...kwHits.map((h) => h.score));
  const maxSem = Math.max(1, ...semHits.map((h) => h.similarity));

  const kwMap = new Map<string, KeywordHit>(kwHits.map((h) => [h.session.id, h]));
  const semMap = new Map<string, SemanticHit>(semHits.map((h) => [h.session.id, h]));
  const allIds = new Set<string>([...kwMap.keys(), ...semMap.keys()]);

  const rows: RecallHit[] = [];
  for (const id of allIds) {
    const kw = kwMap.get(id);
    const sem = semMap.get(id);
    const session = (kw ?? sem)!.session;
    const kwNorm = kw ? kw.score / maxKw : 0;
    const semNorm = sem ? sem.similarity / maxSem : 0;
    const combined = round4(HYBRID_SEM_WEIGHT * semNorm + HYBRID_KW_WEIGHT * kwNorm);
    const matchedIn = uniqueFields(kw?.matchedIn ?? [], sem ? (["semantic"] as MatchField[]) : []);
    rows.push({
      ...sessionHitFields(session),
      matchScore: combined,
      matchedIn,
      keywordScore: round4(kwNorm),
      semanticScore: round4(semNorm),
    });
  }
  rows.sort((a, b) => b.matchScore - a.matchScore);
  return rows;
}

function toKeywordHit(h: KeywordHit): RecallHit {
  return {
    ...sessionHitFields(h.session),
    matchScore: h.score,
    matchedIn: h.matchedIn,
  };
}

function toSemanticHit(h: SemanticHit): RecallHit {
  return {
    ...sessionHitFields(h.session),
    matchScore: h.similarity,
    matchedIn: ["semantic"],
  };
}

function sessionHitFields(s: Session) {
  return {
    id: s.id,
    startedAt: s.startedAt,
    label: s.label,
    summary: s.summary,
    entities: s.entities,
    decisions: s.decisions,
    open: s.open,
    status: s.status,
  } as const;
}

function finalize(
  query: string,
  entity: string | null,
  kind: RecallResult["kind"],
  mode: RecallMode,
  limit: number,
  hits: ReadonlyArray<RecallHit>,
): RecallResult {
  return {
    query,
    entity,
    kind,
    mode,
    limit,
    total: hits.length,
    results: hits.slice(0, limit),
  };
}

function clampLimit(limit: number | undefined): number {
  const n = limit ?? DEFAULT_LIMIT;
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(MAX_LIMIT, Math.trunc(n));
}

function cosineFromL2(distance: number): number {
  // session_embeddings stores unit-normalized vectors. For unit vectors,
  // cos_sim = 1 - L2^2 / 2. Mirrors recall.py:_run_semantic.
  const cos = 1 - (distance * distance) / 2;
  return round4(Math.max(-1, Math.min(1, cos)));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function uniqueFields(
  a: ReadonlyArray<MatchField>,
  b: ReadonlyArray<MatchField>,
): ReadonlyArray<MatchField> {
  const seen = new Set<MatchField>();
  const out: MatchField[] = [];
  for (const f of [...a, ...b]) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}
