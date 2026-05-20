/**
 * Fact query log + stats. The measurement surface for "are agents actually
 * using the FactStore" — mirrors core/recall/query-log.ts but for fact
 * recall. Every /api/recall/facts call appends one line; /api/recall/facts/
 * stats reads it back.
 *
 * Telemetry path — never raises. File format: one JSON object per line at
 * $NLM_FACT_QUERY_LOG or ~/.nlm/fact_query_log.jsonl. Append-only.
 *
 * Without this, the FactStore is a write-only system: facts go in via
 * ingest + backfill, but there's no signal on whether anything reads them.
 */
import type { FactKind, RecallMode } from "../../shared/types.js";
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
    readonly top_subjects: ReadonlyArray<{
        readonly subject: string;
        readonly count: number;
    }>;
    readonly top_predicates: ReadonlyArray<{
        readonly predicate: string;
        readonly count: number;
    }>;
    readonly log_present: boolean;
}
export declare function logFactQuery(entry: FactLogEntry, logPath?: string): Promise<void>;
export declare function factRecallStats(days: number, logPath?: string): Promise<FactStatsResult>;
