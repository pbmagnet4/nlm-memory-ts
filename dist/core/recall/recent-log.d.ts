/**
 * recentLog — tail the query log for the /live observability panel.
 * Returns the last N entries in chronological order (most recent first).
 */
export interface RecentLogEntry {
    readonly ts: string;
    readonly source: string;
    readonly query: string | null;
    readonly entity: string | null;
    readonly kind: string | null;
    readonly mode: string;
    readonly limit: number;
    readonly nResults: number;
    readonly returnedIds: ReadonlyArray<string>;
}
export declare function recentQueryLog(limit: number, logPath?: string): RecentLogEntry[];
