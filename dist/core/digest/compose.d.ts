/**
 * Daily digest text composer.
 *
 * Pure function: takes the raw shapes the daemon returns and emits the digest
 * body. No I/O, no Telegram, no fetch — those live in the CLI adapter so this
 * module stays unit-testable without HTTP fixtures.
 *
 * The 7-day numbers come from the server-computed stats (`/api/recall/stats`).
 * The 24-hour slice is derived locally from `recent`, because the server's
 * stats window is fixed at 7 days and we want a tighter view for the morning
 * push. Probe/test queries are filtered out of both windows.
 */
/** Substrings that mark a recall as test traffic, not real agent usage. */
export declare const PROBE_PATTERNS: ReadonlyArray<string>;
export declare function isProbe(query: string | null | undefined): boolean;
export interface RecallStats {
    readonly total: number;
    readonly hit_rate: number;
    readonly useful_hit_rate: number | null;
    readonly top_queries: ReadonlyArray<{
        readonly query: string;
        readonly count: number;
    }>;
}
export interface RecentEntry {
    readonly ts: string;
    readonly source?: string;
    readonly query?: string | null;
}
export interface ComposeInput {
    readonly stats: RecallStats;
    readonly recent: ReadonlyArray<RecentEntry>;
    readonly port: number;
    readonly hookAlert: string | null;
    /** Override "now" for deterministic tests; defaults to Date.now(). */
    readonly now?: Date;
}
export declare function composeDigest(input: ComposeInput): string;
