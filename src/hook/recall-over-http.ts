/**
 * Shared HTTP recall client for hook entrypoints (Claude Code script, pi extension).
 *
 * Keyword (FTS5) only — hybrid would round-trip through Ollama embedding
 * (~5s warm), too slow to block a user prompt.
 */

import type { RecallHitInput } from "@core/hook/select.js";
import { hookAuthHeaders } from "./hook-auth.js";

export const RECALL_LIMIT = 5;
export const RECALL_TIMEOUT_MS = 2000;

export async function recallOverHttp(
  prompt: string,
  runtime?: string,
): Promise<ReadonlyArray<RecallHitInput>> {
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url =
    `http://localhost:${portValue}/api/recall` +
    `?q=${encodeURIComponent(prompt)}&mode=keyword&limit=${RECALL_LIMIT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  try {
    const extra: Record<string, string> = { "x-recall-source": "hook" };
    if (runtime) extra["x-recall-runtime"] = runtime;
    const res = await fetch(url, {
      headers: hookAuthHeaders(extra),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    type RecallBody = {
      results?: ReadonlyArray<{
        id: string;
        label: string;
        startedAt: string;
        matchScore: number;
      }>;
    };
    let body: RecallBody;
    try {
      body = (await res.json()) as RecallBody;
    } catch {
      return [];
    }
    return (body.results ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      startedAt: r.startedAt,
      matchScore: r.matchScore,
    }));
  } finally {
    clearTimeout(timer);
  }
}
