/**
 * `nlm digest` — compose a daily-activity digest from the running daemon and
 * either print it to stdout (default) or POST it to Telegram.
 *
 * Talks to the daemon over HTTP so it works regardless of where the daemon is
 * actually running. If the daemon is unreachable, the Telegram path posts a
 * "daemon unreachable" alert instead of failing silently — the cron user is
 * specifically watching for this telemetry, so silence is worse than noise.
 */
export interface DigestOptions {
    readonly port: number;
    readonly telegram: boolean;
    readonly timeoutMs?: number;
}
export interface DigestResult {
    readonly text: string;
    readonly delivered: "stdout" | "telegram" | "telegram-alert";
    readonly daemonReachable: boolean;
}
export declare function runDigest(opts: DigestOptions): Promise<DigestResult>;
