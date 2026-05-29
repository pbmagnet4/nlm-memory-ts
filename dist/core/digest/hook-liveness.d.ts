/**
 * Hook liveness check — the load-bearing canary for post-install hook drift.
 *
 * The setup-time smoke test catches malformed hook commands at install moment
 * but nothing detects later drift: a node upgrade that moves the binary, a
 * Claude Code hook dispatcher change, hand-edits to `~/.claude/settings.json`,
 * a `dist/` move. Any of these silently stop the hook firing while Claude Code
 * keeps working. Without correlation, the user only notices when recall
 * mysteriously stops appearing — weeks later.
 *
 * The check: if the user ran Claude Code yesterday but no live hook fires were
 * logged, surface an alert. Silence is allowed only when Claude Code itself
 * was silent.
 */
export interface SessionRow {
    readonly runtime?: string;
    readonly started_at?: string;
}
export interface HookLogEntry {
    readonly ts?: string;
    readonly mode?: string;
}
export interface LivenessInput {
    readonly sessions: ReadonlyArray<SessionRow>;
    readonly hookLog: ReadonlyArray<HookLogEntry>;
    readonly hookLogPath: string;
    readonly hookLogExists: boolean;
    /** Override "now" for tests; defaults to Date.now(). */
    readonly now?: Date;
}
/** Returns an alert string if Claude Code ran yesterday but the hook did not. */
export declare function checkHookLiveness(input: LivenessInput): string | null;
