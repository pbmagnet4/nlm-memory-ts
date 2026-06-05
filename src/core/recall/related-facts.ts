/**
 * pickRelatedFacts — Spec G.2 server-side helper that selects 3–5 current
 * high-confidence facts about the entities in the top recall hits.
 *
 * Algorithm:
 *   1. Walk top-N hits, collect a deduped entity set (cap entities so very
 *      entity-rich sessions don't dominate).
 *   2. For each entity, fetch its current (non-superseded) facts from
 *      FactStore.list. Filter to confidence ≥ min.
 *   3. Compute corroboration counts (Spec G.1) for all candidates in a
 *      single batched query.
 *   4. Filter to facts seen across ≥ MIN_CORROBORATION sessions — a fact
 *      asserted by only one session isn't "known" yet for the purposes
 *      of hook injection.
 *   5. Sort by (corroborationCount DESC, confidence DESC) and take limit.
 *
 * Defaults are tunable via env vars (NLM_HOOK_FACT_LIMIT,
 * NLM_HOOK_FACT_MIN_CORROBORATION, NLM_HOOK_FACT_MIN_CONFIDENCE) and any
 * fail in the path returns an empty array so the pointer block degrades
 * to the session-only format. This is a quality enhancement; never let
 * it block recall.
 */

import type { FactStore } from "@ports/fact-store.js";
import type { Fact, RecallHit, RelatedFact } from "@shared/types.js";

const DEFAULT_FACT_LIMIT = 5;
const DEFAULT_MIN_CORROBORATION = 2;
const DEFAULT_MIN_CONFIDENCE = 0.7;
const TOP_HITS_FOR_ENTITY_SCAN = 5;
const MAX_ENTITIES_TO_QUERY = 8;

export interface PickRelatedFactsOptions {
  readonly limit?: number;
  readonly minCorroboration?: number;
  readonly minConfidence?: number;
}

function readInt(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readFloat(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

export async function pickRelatedFacts(
  hits: ReadonlyArray<RecallHit>,
  factStore: FactStore,
  opts: PickRelatedFactsOptions = {},
): Promise<RelatedFact[]> {
  if (hits.length === 0) return [];

  const limit = opts.limit ?? readInt("NLM_HOOK_FACT_LIMIT", DEFAULT_FACT_LIMIT);
  const minCorroboration = opts.minCorroboration ?? readInt(
    "NLM_HOOK_FACT_MIN_CORROBORATION",
    DEFAULT_MIN_CORROBORATION,
  );
  const minConfidence = opts.minConfidence ?? readFloat(
    "NLM_HOOK_FACT_MIN_CONFIDENCE",
    DEFAULT_MIN_CONFIDENCE,
  );

  if (limit <= 0) return [];

  try {
    // 1. Collect entities from the top hits.
    const entities = collectEntities(hits.slice(0, TOP_HITS_FOR_ENTITY_SCAN));
    if (entities.length === 0) return [];

    // 2. Fetch current facts per entity. Parallelize to keep latency bounded.
    const factLists = await Promise.all(
      entities.map((entity) =>
        factStore.list({ subject: entity, includeSuperseded: false }),
      ),
    );

    // 3. Flatten, filter by confidence.
    const candidates: Fact[] = [];
    for (const list of factLists) {
      for (const f of list) {
        if (f.confidence >= minConfidence) candidates.push(f);
      }
    }
    if (candidates.length === 0) return [];

    // 4. Batch-compute corroboration for all candidates.
    const triples = candidates.map((f) => ({
      subject: f.subject,
      predicate: f.predicate,
      value: f.value,
    }));
    const counts = await factStore.corroborationCounts(triples);

    // 5. Build RelatedFact[], filter by minCorroboration, dedupe by
    //    (subject, predicate) — only the most-corroborated value per pair
    //    survives so we don't list "polysignal uses: duckdb" AND
    //    "polysignal uses: postgres" as if both were current.
    const byKey = new Map<string, RelatedFact & { confidence: number }>();
    for (const f of candidates) {
      const corrKey = `${f.subject} ${f.predicate} ${f.value}`;
      const corroborationCount = counts.get(corrKey) ?? 1;
      if (corroborationCount < minCorroboration) continue;
      const dedupeKey = `${f.subject} ${f.predicate}`;
      const existing = byKey.get(dedupeKey);
      if (
        !existing ||
        corroborationCount > existing.corroborationCount ||
        (corroborationCount === existing.corroborationCount && f.confidence > existing.confidence)
      ) {
        byKey.set(dedupeKey, {
          subject: f.subject,
          predicate: f.predicate,
          value: f.value,
          corroborationCount,
          confidence: f.confidence,
        });
      }
    }

    const sorted = [...byKey.values()].sort((a, b) => {
      if (b.corroborationCount !== a.corroborationCount) {
        return b.corroborationCount - a.corroborationCount;
      }
      return b.confidence - a.confidence;
    });

    return sorted.slice(0, limit).map((r) => ({
      subject: r.subject,
      predicate: r.predicate,
      value: r.value,
      corroborationCount: r.corroborationCount,
    }));
  } catch {
    // Fail-open: empty array means the pointer block renders session-only.
    return [];
  }
}

function collectEntities(hits: ReadonlyArray<RecallHit>): string[] {
  // Order matters: earlier hits contribute first so the top-ranked
  // session's entities are most likely to make the cut.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    for (const ent of hit.entities) {
      const trimmed = ent.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
      if (out.length >= MAX_ENTITIES_TO_QUERY) return out;
    }
  }
  return out;
}
