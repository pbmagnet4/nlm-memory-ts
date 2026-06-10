import type { LogEntry } from "./query-log.js";
import type { CitationEntry } from "./citation-log.js";

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

export function computePrecision(
  queries: ReadonlyArray<{ conversationId: string; entry: LogEntry }>,
  citations: ReadonlyArray<CitationEntry>,
): PrecisionResult {
  const citedByConv = new Map<string, Set<string>>();
  for (const c of citations) {
    let s = citedByConv.get(c.conversationId);
    if (!s) {
      s = new Set();
      citedByConv.set(c.conversationId, s);
    }
    s.add(c.citedId);
  }

  const surfacedByConv = new Map<string, Set<string>>();
  for (const { conversationId, entry } of queries) {
    let s = surfacedByConv.get(conversationId);
    if (!s) {
      s = new Set();
      surfacedByConv.set(conversationId, s);
    }
    for (const id of entry.returnedIds) s.add(id);
  }

  const perConversation: Array<{
    readonly conversationId: string;
    readonly surfaced: number;
    readonly cited: number;
    readonly precision: number;
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
    perConversation.reduce((sum, r) => sum + r.precision, 0) /
    perConversation.length;

  perConversation.sort((a, b) => a.precision - b.precision);

  return {
    precisionAtK: avg,
    conversationCount: perConversation.length,
    perConversation,
  };
}
