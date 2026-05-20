/**
 * RecallService — the use case. Composes filters, keyword scoring, and
 * semantic search into a single recall operation.
 *
 * Depends only on ports (SessionStore, LLMClient). No framework imports,
 * no SQLite, no HTTP. Tests substitute fake adapters.
 */
import { LLMUnreachableError } from "../../ports/llm-client.js";
import { applyFilter } from "./filter.js";
import { scoreKeyword } from "./score-keyword.js";
import { tokenSet } from "./tokenize.js";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const HYBRID_KW_WEIGHT = 0.4;
const HYBRID_SEM_WEIGHT = 0.6;
const SEMANTIC_OVERFETCH = 3;
export class RecallService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async search(input) {
        const mode = input.mode ?? "keyword";
        const limit = clampLimit(input.limit);
        const entity = input.entity ?? null;
        const kind = input.kind ?? null;
        const empty = {
            query: input.query,
            entity,
            kind,
            mode,
            limit,
            total: 0,
            results: [],
        };
        if (!input.query && !entity && !kind)
            return empty;
        const filterArgs = {};
        if (input.entity !== undefined)
            filterArgs.entity = input.entity;
        if (input.kind !== undefined)
            filterArgs.kind = input.kind;
        const allSessions = await this.deps.store.list();
        const filtered = applyFilter(allSessions, filterArgs);
        const byId = new Map(filtered.map((s) => [s.id, s]));
        const queryTokens = input.query ? new Set(tokenSet(input.query)) : new Set();
        const kwHits = mode === "keyword" || mode === "hybrid"
            ? scoreAll(filtered, queryTokens)
            : [];
        let semHits = [];
        let semError = null;
        if ((mode === "semantic" || mode === "hybrid") && input.query) {
            try {
                semHits = await this.runSemantic(input.query, byId, limit * SEMANTIC_OVERFETCH);
            }
            catch (err) {
                if (err instanceof LLMUnreachableError) {
                    semError = "ollama_unreachable";
                }
                else {
                    throw err;
                }
            }
        }
        if (mode === "semantic" && semError) {
            return { ...empty, modeUnavailable: semError };
        }
        if (mode === "keyword") {
            return finalize(input.query, entity, kind, mode, limit, kwHits.map(toKeywordHit));
        }
        if (mode === "semantic") {
            return finalize(input.query, entity, kind, mode, limit, semHits.map(toSemanticHit));
        }
        // hybrid
        const merged = mergeHybrid(kwHits, semHits, byId);
        const result = finalize(input.query, entity, kind, mode, limit, merged);
        return semError ? { ...result, modeUnavailable: semError } : result;
    }
    async runSemantic(query, byId, fetchLimit) {
        const embedding = await this.deps.llm.embed(query, "query");
        const neighbors = await this.deps.store.semanticSearch(embedding.vector, fetchLimit);
        const hits = [];
        for (const n of neighbors) {
            const session = byId.get(n.sessionId);
            if (!session)
                continue;
            hits.push({ session, similarity: cosineFromL2(n.distance) });
        }
        return hits;
    }
}
function scoreAll(sessions, queryTokens) {
    if (queryTokens.size === 0)
        return [];
    const hits = [];
    for (const s of sessions) {
        const { score, matchedIn } = scoreKeyword(s, queryTokens);
        if (score > 0)
            hits.push({ session: s, score, matchedIn });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
}
function mergeHybrid(kwHits, semHits, byId) {
    const maxKw = Math.max(1, ...kwHits.map((h) => h.score));
    const maxSem = Math.max(1, ...semHits.map((h) => h.similarity));
    const kwMap = new Map(kwHits.map((h) => [h.session.id, h]));
    const semMap = new Map(semHits.map((h) => [h.session.id, h]));
    const allIds = new Set([...kwMap.keys(), ...semMap.keys()]);
    const rows = [];
    for (const id of allIds) {
        const session = byId.get(id);
        if (!session)
            continue;
        const kw = kwMap.get(id);
        const sem = semMap.get(id);
        const kwNorm = kw ? kw.score / maxKw : 0;
        const semNorm = sem ? sem.similarity / maxSem : 0;
        const combined = round4(HYBRID_SEM_WEIGHT * semNorm + HYBRID_KW_WEIGHT * kwNorm);
        const matchedIn = uniqueFields(kw?.matchedIn ?? [], sem ? ["semantic"] : []);
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
function toKeywordHit(h) {
    return {
        ...sessionHitFields(h.session),
        matchScore: h.score,
        matchedIn: h.matchedIn,
    };
}
function toSemanticHit(h) {
    return {
        ...sessionHitFields(h.session),
        matchScore: h.similarity,
        matchedIn: ["semantic"],
    };
}
function sessionHitFields(s) {
    return {
        id: s.id,
        startedAt: s.startedAt,
        label: s.label,
        summary: s.summary,
        entities: s.entities,
        decisions: s.decisions,
        open: s.open,
        status: s.status,
    };
}
function finalize(query, entity, kind, mode, limit, hits) {
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
function clampLimit(limit) {
    const n = limit ?? DEFAULT_LIMIT;
    if (Number.isNaN(n) || n < 1)
        return 1;
    return Math.min(MAX_LIMIT, Math.trunc(n));
}
function cosineFromL2(distance) {
    // session_embeddings stores unit-normalized vectors. For unit vectors,
    // cos_sim = 1 - L2^2 / 2. Mirrors recall.py:_run_semantic.
    const cos = 1 - (distance * distance) / 2;
    return round4(Math.max(-1, Math.min(1, cos)));
}
function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}
function uniqueFields(a, b) {
    const seen = new Set();
    const out = [];
    for (const f of [...a, ...b]) {
        if (!seen.has(f)) {
            seen.add(f);
            out.push(f);
        }
    }
    return out;
}
//# sourceMappingURL=recall-service.js.map