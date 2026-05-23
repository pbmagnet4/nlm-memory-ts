/**
 * FactRecallService — agent-facing recall over the FactStore.
 *
 * Mirrors RecallService's keyword / semantic / hybrid pattern but works on
 * Fact records, not Session records. Sessions and facts answer different
 * questions and have incompatibly-shaped results, so this is a separate
 * service with its own MCP tool — see Section 4 of factstore-design.md.
 *
 * Filter pipeline:
 *   1. Storage pre-filter (subject, predicate, kind, minConfidence,
 *      includeSuperseded). Cheap SQL.
 *   2. Keyword scoring over (value, subject, predicate). Pure, in-memory.
 *   3. Semantic KNN via fact_embeddings vec0 (when mode != keyword).
 *   4. Hybrid merge: 0.6 semantic + 0.4 keyword, matching the session
 *      recall weights.
 *
 * Confidence policy: default `minConfidence` is 0.6 (Section 1 of the plan).
 * Facts with classifier confidence in [0.4, 0.6) get written by
 * extractFacts but stay out of agent recall unless the caller lowers the
 * floor explicitly.
 */

import type { FactStore } from "@ports/fact-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";
import type {
  Fact,
  FactHit,
  FactMatchField,
  FactRecallQuery,
  FactRecallResult,
  RecallMode,
} from "@shared/types.js";
import { tokenSet } from "@core/recall/tokenize.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const STORAGE_FETCH_CAP = 500;
const HYBRID_KW_WEIGHT = 0.4;
const HYBRID_SEM_WEIGHT = 0.6;
const SEMANTIC_OVERFETCH = 3;

const FIELD_WEIGHTS = {
  value: 3,
  subject: 1,
  predicate: 1,
} as const;

export interface FactRecallServiceDeps {
  readonly factStore: FactStore;
  readonly llm: LLMClient;
}

export class FactRecallService {
  constructor(private readonly deps: FactRecallServiceDeps) {}

  async search(input: FactRecallQuery): Promise<FactRecallResult> {
    const mode: RecallMode = input.mode ?? "keyword";
    const limit = clampLimit(input.limit);
    const subject = input.subject ?? null;
    const predicate = input.predicate ?? null;
    const kind = input.kind ?? null;
    const queryText = (input.query ?? "").trim();

    const empty: FactRecallResult = {
      query: queryText,
      subject,
      predicate,
      kind,
      mode,
      limit,
      total: 0,
      results: [],
    };

    // A query with no signal at all → empty. Either free-text query, or a
    // structured filter (subject / predicate / kind) must be provided.
    if (!queryText && subject === null && predicate === null && kind === null) {
      return empty;
    }

    const filter: Parameters<FactStore["listForRecall"]>[0] = {
      includeSuperseded: input.includeSuperseded === true,
      minConfidence: input.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
      limit: STORAGE_FETCH_CAP,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.predicate !== undefined ? { predicate: input.predicate } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
    };

    const candidates = await this.deps.factStore.listForRecall(filter);
    if (candidates.length === 0) return empty;

    const byId = new Map<string, Fact>(candidates.map((f) => [f.id, f]));
    const queryTokens = queryText ? new Set(tokenSet(queryText)) : new Set<string>();

    const kwHits =
      mode === "keyword" || mode === "hybrid"
        ? scoreAll(candidates, queryTokens)
        : [];

    let semHits: ReadonlyArray<SemanticHit> = [];
    let semError: "ollama_unreachable" | null = null;
    if ((mode === "semantic" || mode === "hybrid") && queryText) {
      try {
        semHits = await this.runSemantic(queryText, byId, limit * SEMANTIC_OVERFETCH);
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

    // For pure structured queries (no query text, just subject/predicate),
    // a keyword pass with empty tokens scores zero and a semantic pass has
    // nothing to embed. Fall back to returning the storage filter result
    // ordered by created_at DESC. Applies to keyword AND hybrid — hybrid
    // is the MCP default, so this path catches exact subject+predicate
    // lookups from agent callers that pass no query text.
    if ((mode === "keyword" || mode === "hybrid") && !queryText) {
      const rows = candidates
        .slice(0, limit)
        .map((f) => factToHit(f, 0, []));
      return finalize(queryText, subject, predicate, kind, mode, limit, rows);
    }

    if (mode === "keyword") {
      return finalize(queryText, subject, predicate, kind, mode, limit, kwHits.map(toKeywordHit));
    }

    if (mode === "semantic") {
      return finalize(queryText, subject, predicate, kind, mode, limit, semHits.map(toSemanticHit));
    }

    // hybrid
    const merged = mergeHybrid(kwHits, semHits, byId);
    const result = finalize(queryText, subject, predicate, kind, mode, limit, merged);
    return semError ? { ...result, modeUnavailable: semError } : result;
  }

  private async runSemantic(
    query: string,
    byId: ReadonlyMap<string, Fact>,
    fetchLimit: number,
  ): Promise<ReadonlyArray<SemanticHit>> {
    const embedding = await this.deps.llm.embed(query, "query");
    const neighbors = await this.deps.factStore.semanticSearch(embedding.vector, fetchLimit);
    const hits: SemanticHit[] = [];
    for (const n of neighbors) {
      const fact = byId.get(n.factId);
      if (!fact) continue; // candidate was filtered out by subject/predicate/conf
      hits.push({ fact, similarity: cosineFromL2(n.distance) });
    }
    return hits;
  }
}

interface KeywordHit {
  readonly fact: Fact;
  readonly score: number;
  readonly matchedIn: ReadonlyArray<FactMatchField>;
}

interface SemanticHit {
  readonly fact: Fact;
  readonly similarity: number;
}

function scoreAll(
  facts: ReadonlyArray<Fact>,
  queryTokens: ReadonlySet<string>,
): ReadonlyArray<KeywordHit> {
  if (queryTokens.size === 0) return [];
  const hits: KeywordHit[] = [];
  for (const f of facts) {
    const { score, matchedIn } = scoreFact(f, queryTokens);
    if (score > 0) hits.push({ fact: f, score, matchedIn });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

function scoreFact(
  fact: Fact,
  queryTokens: ReadonlySet<string>,
): { score: number; matchedIn: ReadonlyArray<FactMatchField> } {
  let score = 0;
  const matchedIn: FactMatchField[] = [];

  const valueMatches = intersectionSize(queryTokens, tokenSet(fact.value));
  if (valueMatches > 0) {
    score += FIELD_WEIGHTS.value * valueMatches;
    matchedIn.push("value");
  }

  const subjectMatches = intersectionSize(queryTokens, tokenSet(fact.subject));
  if (subjectMatches > 0) {
    score += FIELD_WEIGHTS.subject * subjectMatches;
    matchedIn.push("subject");
  }

  const predicateMatches = intersectionSize(queryTokens, tokenSet(fact.predicate));
  if (predicateMatches > 0) {
    score += FIELD_WEIGHTS.predicate * predicateMatches;
    matchedIn.push("predicate");
  }

  return { score, matchedIn };
}

function mergeHybrid(
  kwHits: ReadonlyArray<KeywordHit>,
  semHits: ReadonlyArray<SemanticHit>,
  byId: ReadonlyMap<string, Fact>,
): ReadonlyArray<FactHit> {
  const maxKw = Math.max(1, ...kwHits.map((h) => h.score));
  const maxSem = Math.max(1, ...semHits.map((h) => h.similarity));

  const kwMap = new Map<string, KeywordHit>(kwHits.map((h) => [h.fact.id, h]));
  const semMap = new Map<string, SemanticHit>(semHits.map((h) => [h.fact.id, h]));
  const allIds = new Set<string>([...kwMap.keys(), ...semMap.keys()]);

  const rows: FactHit[] = [];
  for (const id of allIds) {
    const fact = byId.get(id);
    if (!fact) continue;
    const kw = kwMap.get(id);
    const sem = semMap.get(id);
    const kwNorm = kw ? kw.score / maxKw : 0;
    const semNorm = sem ? sem.similarity / maxSem : 0;
    const combined = round4(HYBRID_SEM_WEIGHT * semNorm + HYBRID_KW_WEIGHT * kwNorm);
    const matchedIn = uniqueFields(
      kw?.matchedIn ?? [],
      sem ? (["semantic"] as FactMatchField[]) : [],
    );
    rows.push({
      ...fact,
      matchScore: combined,
      matchedIn,
      keywordScore: round4(kwNorm),
      semanticScore: round4(semNorm),
    });
  }
  rows.sort((a, b) => b.matchScore - a.matchScore);
  return rows;
}

function factToHit(
  fact: Fact,
  score: number,
  matchedIn: ReadonlyArray<FactMatchField>,
): FactHit {
  return { ...fact, matchScore: score, matchedIn };
}

function toKeywordHit(h: KeywordHit): FactHit {
  return factToHit(h.fact, h.score, h.matchedIn);
}

function toSemanticHit(h: SemanticHit): FactHit {
  return factToHit(h.fact, h.similarity, ["semantic"]);
}

function finalize(
  query: string,
  subject: string | null,
  predicate: string | null,
  kind: FactRecallResult["kind"],
  mode: RecallMode,
  limit: number,
  hits: ReadonlyArray<FactHit>,
): FactRecallResult {
  return {
    query,
    subject,
    predicate,
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
  const cos = 1 - (distance * distance) / 2;
  return round4(Math.max(-1, Math.min(1, cos)));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function intersectionSize<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const item of small) if (large.has(item)) count += 1;
  return count;
}

function uniqueFields(
  a: ReadonlyArray<FactMatchField>,
  b: ReadonlyArray<FactMatchField>,
): ReadonlyArray<FactMatchField> {
  const seen = new Set<FactMatchField>();
  const out: FactMatchField[] = [];
  for (const f of [...a, ...b]) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}
