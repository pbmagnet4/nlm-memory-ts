/**
 * RecallService — the use case. Composes filters, keyword scoring, and
 * semantic search into a single recall operation.
 *
 * Depends only on ports (SessionStore, LLMClient). No framework imports,
 * no SQLite, no HTTP. Tests substitute fake adapters.
 */

import type { FactStore } from "@ports/fact-store.js";
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
import { detectQueryShape } from "./query-shape.js";
import { recencyMultiplier } from "./recency.js";
import { pickRelatedFacts } from "./related-facts.js";
import { RewriteCache } from "./rewrite-cache.js";
import { tokenSet } from "./tokenize.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function isFactInjectionEnabled(): boolean {
  const raw = process.env["NLM_HOOK_INJECT_FACTS"];
  if (raw === undefined) return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}
// Reciprocal Rank Fusion constant (Cormack et al. 2009). k=60 is the
// canonical literature default. RRF combines ranked lists from multiple
// retrievers by summing 1/(k + rank) per retriever, ignoring raw scores —
// robust to wildly different score distributions (BM25 unbounded vs cosine
// in [-1,1]) without requiring normalization.
const RRF_K = 60;
const SEMANTIC_OVERFETCH = 3;
const KEYWORD_OVERFETCH = 3;

export interface RecallServiceDeps {
  readonly store: SessionStore;
  readonly llm: LLMClient;
  /**
   * Spec G.2: when present, RecallService can attach `relatedFacts` to its
   * results for callers that request `withRelatedFacts`. Optional — tests
   * and lightweight callers (CLI debugging) can omit it without losing
   * core recall functionality.
   */
  readonly factStore?: FactStore;
}

export class RecallService {
  private readonly rewriteCache = new RewriteCache();

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

    // 0. Optional query rewrite. Fails open on LLM unreachable / parse error:
    //    keyword and semantic both fall back to the raw query, preserving
    //    pre-spec-C behavior. Cached for 5min to amortize repeat calls.
    let keywordQuery = input.query;
    let semanticQuery = input.query;
    if (input.rewrite === true && input.query) {
      const cached = this.rewriteCache.get(input.query);
      if (cached) {
        keywordQuery = cached.keywordQuery;
        semanticQuery = cached.semanticQuery;
      } else {
        try {
          const rewritten = await this.deps.llm.rewriteForRecall(input.query);
          this.rewriteCache.set(input.query, rewritten);
          keywordQuery = rewritten.keywordQuery;
          semanticQuery = rewritten.semanticQuery;
        } catch (err) {
          if (!(err instanceof LLMUnreachableError)) throw err;
          // fail-open: keywordQuery / semanticQuery already set to raw input.query
        }
      }
    }

    // 1. Search legs — ranked neighbor IDs only. No session bodies loaded.
    const kwNeighbors: ReadonlyArray<KeywordNeighbor> =
      (mode === "keyword" || mode === "hybrid") && keywordQuery
        ? await this.deps.store.keywordSearch(keywordQuery, limit * KEYWORD_OVERFETCH)
        : [];

    let semNeighbors: ReadonlyArray<SemanticNeighbor> = [];
    let semError: "ollama_unreachable" | null = null;
    if ((mode === "semantic" || mode === "hybrid") && semanticQuery) {
      try {
        const embedding = await this.deps.llm.embed(semanticQuery, "query");
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
    //    matchedIn uses the keyword (possibly rewritten) query so the badge
    //    reflects the tokens that actually drove the search.
    const queryTokens = keywordQuery
      ? new Set(tokenSet(keywordQuery))
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
    let result: RecallResult;
    if (mode === "keyword") {
      result = finalize(input.query, entity, kind, mode, limit, kwHits.map(toKeywordHit));
    } else if (mode === "semantic") {
      result = finalize(input.query, entity, kind, mode, limit, semHits.map(toSemanticHit));
    } else {
      const merged = mergeHybrid(kwHits, semHits);
      const shape = detectQueryShape(input.query);
      const forceIncluded = (shape.hasTemporal && shape.hasNamedEntity)
        ? forceIncludeKeywordTop(merged, kwHits, limit)
        : merged;
      result = finalize(input.query, entity, kind, mode, limit, forceIncluded);
      if (semError) result = { ...result, modeUnavailable: semError };
    }

    // 5. Spec G.2: optionally attach high-confidence facts about top entities.
    //    Only runs when the caller opts in AND a FactStore is wired. Failures
    //    silently no-op so recall never breaks because of fact lookup.
    if (input.withRelatedFacts === true && this.deps.factStore && isFactInjectionEnabled()) {
      const relatedFacts = await pickRelatedFacts(result.results, this.deps.factStore);
      if (relatedFacts.length > 0) {
        result = { ...result, relatedFacts };
      }
    }

    return result;
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

/**
 * Reciprocal Rank Fusion across the keyword + semantic legs.
 *
 * matchScore = Σ 1/(RRF_K + rank_i) for each retriever the session appears in.
 * A session at rank 1 in both retrievers therefore scores ~0.0328 (the max
 * possible with two retrievers at k=60); a session at rank 1 in one
 * retriever and absent from the other scores ~0.0164.
 *
 * keywordScore and semanticScore stay populated as min-max normalized
 * informational values so the UI can show "how strong was each leg" —
 * they're no longer used to compute matchScore.
 */
function mergeHybrid(
  kwHits: ReadonlyArray<KeywordHit>,
  semHits: ReadonlyArray<SemanticHit>,
): ReadonlyArray<RecallHit> {
  const maxKw = Math.max(1, ...kwHits.map((h) => h.score));
  const maxSem = Math.max(1, ...semHits.map((h) => h.similarity));

  const kwRank = new Map<string, number>();
  kwHits.forEach((h, i) => kwRank.set(h.session.id, i + 1));
  const semRank = new Map<string, number>();
  semHits.forEach((h, i) => semRank.set(h.session.id, i + 1));

  const kwMap = new Map<string, KeywordHit>(kwHits.map((h) => [h.session.id, h]));
  const semMap = new Map<string, SemanticHit>(semHits.map((h) => [h.session.id, h]));
  const allIds = new Set<string>([...kwMap.keys(), ...semMap.keys()]);

  const rows: RecallHit[] = [];
  for (const id of allIds) {
    const kw = kwMap.get(id);
    const sem = semMap.get(id);
    const session = (kw ?? sem)!.session;
    const kRank = kwRank.get(id);
    const sRank = semRank.get(id);
    const rrf =
      (kRank !== undefined ? 1 / (RRF_K + kRank) : 0) +
      (sRank !== undefined ? 1 / (RRF_K + sRank) : 0);
    const matchedIn = uniqueFields(kw?.matchedIn ?? [], sem ? (["semantic"] as MatchField[]) : []);
    rows.push({
      ...sessionHitFields(session),
      matchScore: round4(rrf),
      matchedIn,
      keywordScore: kw ? round4(kw.score / maxKw) : 0,
      semanticScore: sem ? round4(sem.similarity / maxSem) : 0,
    });
  }
  rows.sort((a, b) => b.matchScore - a.matchScore);
  return rows;
}

/**
 * Force-include the keyword-leg rank-1 session into the merged top-`limit`
 * result. Only invoked when the query shape (temporal + named entity)
 * indicates a Mode A pattern where pure RRF is known to demote keyword
 * winners (see query-shape.ts for diagnosis). If the rank-1 keyword session
 * is already in the limited top-N, no change. Otherwise it's inserted at
 * position `limit - 1`, displacing the lowest-confidence merged hit.
 */
function forceIncludeKeywordTop(
  merged: ReadonlyArray<RecallHit>,
  kwHits: ReadonlyArray<KeywordHit>,
  limit: number,
): ReadonlyArray<RecallHit> {
  if (kwHits.length === 0 || merged.length === 0) return merged;
  const topId = kwHits[0]!.session.id;
  const top = merged.slice(0, limit);
  if (top.some((h) => h.id === topId)) return merged;
  const forcedHit = merged.find((h) => h.id === topId);
  if (!forcedHit) return merged;
  const kept = top.slice(0, Math.max(0, limit - 1));
  const tail = merged.slice(limit);
  return [...kept, forcedHit, ...tail];
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
  // Apply recency decay to every hit, then re-sort by adjusted score so
  // newer sessions surface ahead of equally-relevant older ones. The decay
  // is multiplicative; within a single query all hits use the same scale
  // (BM25, similarity, or RRF) so the multiplier preserves intra-mode
  // ranking when ages are similar and skews recent when ages diverge.
  // Disable per-deployment with NLM_RECALL_DECAY_HALF_LIFE_DAYS=0.
  const now = Date.now();
  const adjusted: RecallHit[] = hits.map((h) => ({
    ...h,
    matchScore: round4(h.matchScore * recencyMultiplier(h.startedAt, now)),
  }));
  adjusted.sort((a, b) => b.matchScore - a.matchScore);
  return {
    query,
    entity,
    kind,
    mode,
    limit,
    total: adjusted.length,
    results: adjusted.slice(0, limit),
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
