import type { LogEntry } from "./query-log.js";
import type { CitationEntry } from "./citation-log.js";
import type { HookRecallEntry } from "./hook-recall-log.js";

export interface PrecisionResult {
  readonly precisionAtK: number | null;
  readonly conversationCount: number;
  readonly perConversation: ReadonlyArray<{
    readonly conversationId: string;
    readonly surfaced: number;
    readonly cited: number;
    readonly precision: number;
  }>;
}

export interface SourcePrecision {
  readonly source: string;
  readonly precision: number;
  readonly conversationCount: number;
}

function citedByConversation(citations: ReadonlyArray<CitationEntry>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of citations) {
    let s = out.get(c.conversationId);
    if (!s) {
      s = new Set();
      out.set(c.conversationId, s);
    }
    s.add(c.citedId);
  }
  return out;
}

function precisionOverSurfaced(
  surfacedByConv: Map<string, Set<string>>,
  citedByConv: Map<string, Set<string>>,
): PrecisionResult {
  const perConversation: Array<{
    conversationId: string;
    surfaced: number;
    cited: number;
    precision: number;
  }> = [];

  for (const [convId, surfaced] of surfacedByConv) {
    if (surfaced.size === 0) continue;
    const cited = citedByConv.get(convId) ?? new Set<string>();
    const hits = [...surfaced].filter((id) => cited.has(id)).length;
    perConversation.push({
      conversationId: convId,
      surfaced: surfaced.size,
      cited: hits,
      precision: hits / surfaced.size,
    });
  }

  if (perConversation.length === 0) {
    return { precisionAtK: null, conversationCount: 0, perConversation: [] };
  }

  const avg =
    perConversation.reduce((sum, r) => sum + r.precision, 0) / perConversation.length;
  perConversation.sort((a, b) => a.precision - b.precision);

  return { precisionAtK: avg, conversationCount: perConversation.length, perConversation };
}

/**
 * Blended recall precision: fraction of hook-surfaced sessions later cited in
 * the same conversation. Reads the hook-log surfaced set (which carries the
 * real conversationId) rather than query_log (which almost never does), so
 * conversations join correctly against the citation log.
 */
export function computePrecision(
  recalls: ReadonlyArray<HookRecallEntry>,
  citations: ReadonlyArray<CitationEntry>,
): PrecisionResult {
  const citedByConv = citedByConversation(citations);
  const surfacedByConv = new Map<string, Set<string>>();
  for (const { conversationId, injectedIds } of recalls) {
    let s = surfacedByConv.get(conversationId);
    if (!s) {
      s = new Set();
      surfacedByConv.set(conversationId, s);
    }
    for (const id of injectedIds) s.add(id);
  }
  return precisionOverSurfaced(surfacedByConv, citedByConv);
}

/**
 * Per-source precision. Uses query_log entries (the only recall log carrying a
 * `source` field) joined against the citation log by conversationId. A source
 * only appears when at least one of its entries carries a real conversationId
 * AND ≥1 returned id — sources that never capture a conversationId (currently
 * mcp/http) are unmeasurable here and are returned in `unmeasurable` rather
 * than counted at a fabricated 0%.
 */
export function computePerSourcePrecision(
  queries: ReadonlyArray<{ conversationId: string; entry: LogEntry }>,
  citations: ReadonlyArray<CitationEntry>,
): { perSource: ReadonlyArray<SourcePrecision>; unmeasurable: ReadonlyArray<string> } {
  const citedByConv = citedByConversation(citations);

  const surfacedBySource = new Map<string, Map<string, Set<string>>>();
  const sourcesSeen = new Set<string>();
  for (const { conversationId, entry } of queries) {
    sourcesSeen.add(entry.source);
    if (conversationId === "unknown" || entry.returnedIds.length === 0) continue;
    let byConv = surfacedBySource.get(entry.source);
    if (!byConv) {
      byConv = new Map();
      surfacedBySource.set(entry.source, byConv);
    }
    let s = byConv.get(conversationId);
    if (!s) {
      s = new Set();
      byConv.set(conversationId, s);
    }
    for (const id of entry.returnedIds) s.add(id);
  }

  const perSource: SourcePrecision[] = [];
  for (const [source, byConv] of surfacedBySource) {
    const result = precisionOverSurfaced(byConv, citedByConv);
    if (result.precisionAtK === null) continue;
    perSource.push({
      source,
      precision: result.precisionAtK,
      conversationCount: result.conversationCount,
    });
  }
  perSource.sort((a, b) => b.conversationCount - a.conversationCount);

  const measurable = new Set(perSource.map((p) => p.source));
  const unmeasurable = [...sourcesSeen].filter((s) => !measurable.has(s)).sort();

  return { perSource, unmeasurable };
}
