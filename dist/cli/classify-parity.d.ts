/**
 * `nlm classify-parity` — Phase C parity verification harness.
 *
 * Reads N sessions from ~/.nlm/canonical.sqlite (read-only by default),
 * runs the TS OllamaClient.classify on each body, diffs the result
 * against the persisted Python classifier output, and prints aggregate
 * metrics: Jaccard similarity on entities/decisions/open sets, label
 * exact match rate, summary length delta, schema-failure count.
 *
 * Safe: opens the live store in readonly mode. Does not write anything
 * back. Designed to be run interactively from a terminal during the
 * Phase C cutover-prep window.
 */
export type Provider = "ollama" | "deepseek";
interface CliOptions {
    readonly limit: number;
    readonly dbPath: string;
    readonly ollamaUrl: string;
    readonly classifyModel: string;
    readonly provider: Provider;
    readonly verbose: boolean;
}
interface DiffMetrics {
    sessionId: string;
    labelMatch: boolean;
    labelTs: string;
    labelPy: string;
    entityJaccard: number;
    decisionJaccard: number;
    openJaccard: number;
    summaryDeltaChars: number;
    schemaFailure: boolean;
    errorMessage?: string;
}
export interface ParityReport {
    attempted: number;
    succeeded: number;
    schemaFailures: number;
    networkFailures: number;
    labelExactMatchRate: number;
    meanEntityJaccard: number;
    meanDecisionJaccard: number;
    meanOpenJaccard: number;
    diffs: ReadonlyArray<DiffMetrics>;
}
export declare function runParity(opts: CliOptions): Promise<ParityReport>;
export declare function main(): Promise<void>;
export {};
