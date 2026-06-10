/**
 * Shared HTTP recall client for hook entrypoints (Claude Code script, pi extension).
 *
 * Keyword (FTS5) only — hybrid would round-trip through Ollama embedding
 * (~5s warm), too slow to block a user prompt.
 *
 * Spec G.2: also extracts the optional `relatedFacts` array (current
 * high-confidence facts about the entities in the top hits). The HTTP
 * handler returns this whenever a hook source asks for it; callers that
 * don't want facts simply ignore the second return value.
 */

import type { RecallHitInput } from "@core/hook/select.js";
import type { PointerFact } from "@core/hook/pointer-block.js";
import { hookAuthHeaders } from "./hook-auth.js";
import { extractRecallQuery } from "@core/hook/query-extract.js";

export const RECALL_LIMIT = 5;
export const RECALL_TIMEOUT_MS = 2000;

export interface RecallOverHttpResult {
  readonly hits: ReadonlyArray<RecallHitInput>;
  readonly facts: ReadonlyArray<PointerFact>;
}

export async function recallOverHttp(
  prompt: string,
  runtime?: string,
): Promise<RecallOverHttpResult> {
  const query = extractRecallQuery(prompt);
  if (query === null) return { hits: [], facts: [] };
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url =
    `http://localhost:${portValue}/api/recall` +
    `?q=${encodeURIComponent(query)}&mode=keyword&limit=${RECALL_LIMIT}&withFacts=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  try {
    const extra: Record<string, string> = { "x-recall-source": "hook" };
    if (runtime) extra["x-recall-runtime"] = runtime;
    const res = await fetch(url, {
      headers: hookAuthHeaders(extra),
      signal: controller.signal,
    });
    if (!res.ok) return { hits: [], facts: [] };
    type RecallBody = {
      results?: ReadonlyArray<{
        id: string;
        label: string;
        startedAt: string;
        matchScore: number;
      }>;
      relatedFacts?: ReadonlyArray<{
        subject: string;
        predicate: string;
        value: string;
        corroborationCount: number;
      }>;
    };
    let body: RecallBody;
    try {
      body = (await res.json()) as RecallBody;
    } catch {
      return { hits: [], facts: [] };
    }
    const hits = (body.results ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      startedAt: r.startedAt,
      matchScore: r.matchScore,
    }));
    const facts = (body.relatedFacts ?? []).map((f) => ({
      subject: f.subject,
      predicate: f.predicate,
      value: f.value,
      corroborationCount: f.corroborationCount,
    }));
    return { hits, facts };
  } finally {
    clearTimeout(timer);
  }
}
