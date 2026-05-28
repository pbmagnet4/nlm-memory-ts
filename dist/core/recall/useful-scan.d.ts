/**
 * Batch scanner for the useful_hit_rate metric.
 *
 * Joins hook-log.jsonl (recall events) against Claude Code conversation
 * transcripts, writes one useful-hit-log.jsonl entry per recall event,
 * and returns aggregate counts.
 *
 * A recall is "useful" when ≥1 of the surfaced session IDs appears in the
 * text or tool_use inputs of the next NEXT_TURNS_LIMIT assistant turns after
 * the hook fired. Entries with no matching transcript get useful=null
 * (unmeasurable).
 *
 * Probe entries (promptPreview matching PROBE_PATTERNS) are excluded from
 * the scan to keep the metric clean.
 */
export interface UsefulHitEntry {
    readonly ts: string;
    readonly source: "hook";
    readonly conversationId: string;
    readonly returnedIds: ReadonlyArray<string>;
    readonly useful: boolean | null;
    readonly matchedId: string | null;
    readonly scannedAt: string;
}
export interface ScanResult {
    readonly total: number;
    readonly measurable: number;
    readonly useful: number;
    readonly appended: number;
}
export declare function defaultUsefulHitLogPath(): string;
export declare function isProbe(promptPreview: string): boolean;
/**
 * Read assistant turns from a Claude Code transcript JSONL that have a
 * timestamp >= afterTs. Returns up to `limit` turns, each as a single
 * concatenated string of text + serialized tool_use inputs.
 */
export declare function extractAssistantTurnsAfter(transcriptPath: string, afterTs: number, limit: number): ReadonlyArray<string>;
export declare function findMatchedId(ids: ReadonlyArray<string>, turns: ReadonlyArray<string>): string | null;
export declare function scanUsefulHits(opts: {
    days?: number;
    hookLogPath?: string;
    usefulHitLogPath?: string;
    transcriptsDir?: string;
    dryRun?: boolean;
}): Promise<ScanResult>;
/**
 * Compute useful_hit_rate from an existing useful-hit-log.jsonl over a
 * rolling window. Returns null if the log is absent or has no measurable
 * entries in the window.
 */
export declare function readUsefulHitRate(usefulHitLogPath?: string, days?: number): Promise<number | null>;
