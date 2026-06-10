/**
 * Append-only JSONL citation log. One line per (conversationId, citedId)
 * that the Stop hook detected. This is the training-data substrate for the
 * future learned reranker: each row is a (query, returned_id, was_cited)
 * triple once joined against ~/.nlm/query_log.jsonl by conversationId.
 *
 * Path defaults to ~/.nlm/citation-log.jsonl, overridable via
 * NLM_CITATION_LOG. Telemetry path — never raises.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type CitationKind = "tool_use" | "prose";

export interface CitationEntry {
  readonly conversationId: string;
  readonly citedId: string;
  readonly kind?: CitationKind;
  readonly responsePreview?: string;
}

export interface CitationStats {
  readonly days: number;
  readonly total: number;
  readonly distinct_ids: number;
  readonly top_ids: ReadonlyArray<{ readonly id: string; readonly count: number }>;
  readonly log_present: boolean;
}

function defaultLogPath(): string {
  return process.env["NLM_CITATION_LOG"] ?? join(homedir(), ".nlm", "citation-log.jsonl");
}

export async function readCitationLog(
  days: number,
  logPath: string = defaultLogPath(),
): Promise<CitationEntry[]> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const results: CitationEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj["ts"] !== "string") continue;
      if (Date.parse(obj["ts"]) < cutoff) continue;
      if (typeof obj["conversation_id"] !== "string" || typeof obj["cited_id"] !== "string") continue;
      const kind = obj["kind"] === "tool_use" || obj["kind"] === "prose" ? obj["kind"] : undefined;
      const responsePreview = typeof obj["response_preview"] === "string" ? obj["response_preview"] : undefined;
      const entry: CitationEntry = {
        conversationId: obj["conversation_id"],
        citedId: obj["cited_id"],
        ...(kind !== undefined ? { kind } : {}),
        ...(responsePreview !== undefined ? { responsePreview } : {}),
      };
      results.push(entry);
    } catch {
      continue;
    }
  }
  return results;
}

export async function appendCitation(
  entry: CitationEntry,
  logPath: string = defaultLogPath(),
): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    const payload = {
      ts: new Date().toISOString(),
      conversation_id: entry.conversationId,
      cited_id: entry.citedId,
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
      ...(entry.responsePreview !== undefined
        ? { response_preview: entry.responsePreview }
        : {}),
    };
    await appendFile(logPath, JSON.stringify(payload) + "\n", "utf8");
  } catch {
    // Telemetry failure must never break the call path.
  }
}

export async function citationStats(
  days: number,
  logPath: string = defaultLogPath(),
): Promise<CitationStats> {
  const base: CitationStats = {
    days,
    total: 0,
    distinct_ids: 0,
    top_ids: [],
    log_present: false,
  };
  try {
    await stat(logPath);
  } catch {
    return base;
  }
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return { ...base, log_present: true };
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const counts = new Map<string, number>();
  let total = 0;
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
    const id = entry["cited_id"];
    if (typeof id !== "string" || !id) continue;
    total += 1;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  return {
    days,
    total,
    distinct_ids: counts.size,
    top_ids: sorted.map(([id, count]) => ({ id, count })),
    log_present: true,
  };
}
