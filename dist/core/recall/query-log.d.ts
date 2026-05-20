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
import type { RecallKindFilter, RecallMode } from "../../shared/types.js";
export interface LogEntry {
    readonly source: string;
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
    readonly top_queries: ReadonlyArray<{
        readonly query: string;
        readonly count: number;
    }>;
    readonly log_present: boolean;
}
export declare function logQuery(entry: LogEntry, logPath?: string): Promise<void>;
export declare function recallStats(days: number, logPath?: string): Promise<StatsResult>;
