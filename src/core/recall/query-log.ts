/**
 * Query log + stats aggregation. Mirrors recall.py's log_query() / stats().
 *
 * Telemetry path — never raises. The HTTP recall handler calls logQuery()
 * after each /api/recall response; /api/recall/stats reads the same file
 * back to drive the Pulse agent-recall observability panel.
 *
 * File format: one JSON object per line at $NLM_QUERY_LOG or
 * ~/.nlm/query_log.jsonl. Append-only.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { RecallKindFilter, RecallMode } from "@shared/types.js";

export interface LogEntry {
  readonly source: string;
  /** Calling agent runtime (claude-code / hermes / pi.dev / codex / etc).
   *  Logged when the caller passes x-recall-runtime; null for legacy entries. */
  readonly runtime: string | null;
  readonly query: string | null;
  readonly entity: string | null;
  readonly kind: RecallKindFilter | null;
  readonly mode: RecallMode;
  readonly limit: number;
  readonly nResults: number;
  readonly returnedIds: ReadonlyArray<string>;
}

export interface StatsResult {
  readonly days: number;
  readonly total: number;
  readonly with_results: number;
  readonly hit_rate: number;
  readonly by_source: Record<string, number>;
  readonly top_queries: ReadonlyArray<{ readonly query: string; readonly count: number }>;
  readonly log_present: boolean;
}

function defaultLogPath(): string {
  return process.env["NLM_QUERY_LOG"] ?? join(homedir(), ".nlm", "query_log.jsonl");
}

export async function logQuery(
  entry: LogEntry,
  logPath: string = defaultLogPath(),
): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    const payload = {
      ts: new Date().toISOString(),
      source: entry.source,
      runtime: entry.runtime,
      query: entry.query,
      entity: entry.entity,
      kind: entry.kind,
      mode: entry.mode,
      limit: entry.limit,
      n_results: entry.nResults,
      returned_ids: entry.returnedIds,
    };
    await appendFile(logPath, JSON.stringify(payload) + "\n", "utf8");
  } catch {
    // Telemetry must never break the call path.
  }
}

export async function readQueryLog(
  days: number,
  logPath: string = defaultLogPath(),
): Promise<Array<{ conversationId: string; entry: LogEntry }>> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const results: Array<{ conversationId: string; entry: LogEntry }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj["ts"] !== "string") continue;
      if (Date.parse(obj["ts"]) < cutoff) continue;
      const convId = typeof obj["conversation_id"] === "string" ? obj["conversation_id"] : "unknown";
      const entry: LogEntry = {
        source: typeof obj["source"] === "string" ? obj["source"] : "",
        runtime: typeof obj["runtime"] === "string" ? obj["runtime"] : null,
        query: typeof obj["query"] === "string" ? obj["query"] : null,
        entity: typeof obj["entity"] === "string" ? obj["entity"] : null,
        kind: (obj["kind"] as LogEntry["kind"]) ?? null,
        mode: (obj["mode"] as LogEntry["mode"]) ?? "keyword",
        limit: Number(obj["limit"] ?? 5),
        nResults: Number(obj["n_results"] ?? 0),
        returnedIds: (obj["returned_ids"] as unknown[]).filter((x): x is string => typeof x === "string"),
      };
      results.push({ conversationId: convId, entry });
    } catch {
      continue;
    }
  }
  return results;
}

export async function recallStats(
  days: number,
  logPath: string = defaultLogPath(),
): Promise<StatsResult> {
  const base: StatsResult = {
    days,
    total: 0,
    with_results: 0,
    hit_rate: 0,
    by_source: {},
    top_queries: [],
    log_present: false,
  };

  try {
    await stat(logPath);
  } catch {
    return base;
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const bySource = new Map<string, number>();
  const queryCounts = new Map<string, number>();
  let total = 0;
  let withResults = 0;

  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return { ...base, log_present: true };
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tsRaw = entry["ts"];
    if (typeof tsRaw !== "string") continue;
    const ts = Date.parse(tsRaw);
    if (!Number.isFinite(ts) || ts < cutoff) continue;

    total += 1;
    const n = typeof entry["n_results"] === "number" ? entry["n_results"] : 0;
    if (n > 0) withResults += 1;

    const source = typeof entry["source"] === "string" ? entry["source"] : "unknown";
    bySource.set(source, (bySource.get(source) ?? 0) + 1);

    const q = entry["query"];
    if (typeof q === "string" && q) {
      const norm = q.toLowerCase().trim();
      queryCounts.set(norm, (queryCounts.get(norm) ?? 0) + 1);
    }
  }

  const sortedSources = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
  const sortedQueries = [...queryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return {
    days,
    total,
    with_results: withResults,
    hit_rate: total === 0 ? 0 : Math.round((withResults / total) * 1000) / 1000,
    by_source: Object.fromEntries(sortedSources),
    top_queries: sortedQueries.map(([query, count]) => ({ query, count })),
    log_present: true,
  };
}
