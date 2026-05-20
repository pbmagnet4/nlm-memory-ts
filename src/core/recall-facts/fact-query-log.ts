/**
 * Fact query log + stats. The measurement surface for "are agents actually
 * using the FactStore" — mirrors core/recall/query-log.ts but for fact
 * recall. Every /api/recall/facts call appends one line; /api/recall/facts/
 * stats reads it back.
 *
 * Telemetry path — never raises. File format: one JSON object per line at
 * $NLE_FACT_QUERY_LOG or ~/.nle/fact_query_log.jsonl. Append-only.
 *
 * Without this, the FactStore is a write-only system: facts go in via
 * ingest + backfill, but there's no signal on whether anything reads them.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { FactKind, RecallMode } from "@shared/types.js";

export interface FactLogEntry {
  readonly source: string;
  readonly query: string | null;
  readonly subject: string | null;
  readonly predicate: string | null;
  readonly kind: FactKind | null;
  readonly mode: RecallMode;
  readonly limit: number;
  readonly nResults: number;
  readonly returnedIds: ReadonlyArray<string>;
}

export interface FactStatsResult {
  readonly days: number;
  readonly total: number;
  readonly with_results: number;
  readonly hit_rate: number;
  readonly by_source: Record<string, number>;
  readonly top_subjects: ReadonlyArray<{ readonly subject: string; readonly count: number }>;
  readonly top_predicates: ReadonlyArray<{ readonly predicate: string; readonly count: number }>;
  readonly log_present: boolean;
}

function defaultLogPath(): string {
  return process.env["NLE_FACT_QUERY_LOG"] ?? join(homedir(), ".nle", "fact_query_log.jsonl");
}

export async function logFactQuery(
  entry: FactLogEntry,
  logPath: string = defaultLogPath(),
): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    const payload = {
      ts: new Date().toISOString(),
      source: entry.source,
      query: entry.query,
      subject: entry.subject,
      predicate: entry.predicate,
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

export async function factRecallStats(
  days: number,
  logPath: string = defaultLogPath(),
): Promise<FactStatsResult> {
  const base: FactStatsResult = {
    days,
    total: 0,
    with_results: 0,
    hit_rate: 0,
    by_source: {},
    top_subjects: [],
    top_predicates: [],
    log_present: false,
  };

  try {
    await stat(logPath);
  } catch {
    return base;
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const bySource = new Map<string, number>();
  const subjectCounts = new Map<string, number>();
  const predicateCounts = new Map<string, number>();
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

    const subj = entry["subject"];
    if (typeof subj === "string" && subj) {
      const norm = subj.toLowerCase().trim();
      subjectCounts.set(norm, (subjectCounts.get(norm) ?? 0) + 1);
    }
    const pred = entry["predicate"];
    if (typeof pred === "string" && pred) {
      predicateCounts.set(pred, (predicateCounts.get(pred) ?? 0) + 1);
    }
  }

  const topN = (m: Map<string, number>): Array<[string, number]> =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  return {
    days,
    total,
    with_results: withResults,
    hit_rate: total === 0 ? 0 : Math.round((withResults / total) * 1000) / 1000,
    by_source: Object.fromEntries([...bySource.entries()].sort((a, b) => b[1] - a[1])),
    top_subjects: topN(subjectCounts).map(([subject, count]) => ({ subject, count })),
    top_predicates: topN(predicateCounts).map(([predicate, count]) => ({ predicate, count })),
    log_present: true,
  };
}
