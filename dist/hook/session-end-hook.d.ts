/**
 * Claude Code SessionEnd hook entrypoint for NLM.
 *
 * Fires when a Claude Code session closes. Deletes the per-conversation
 * memo file written during the session so memo files don't accumulate
 * indefinitely under ~/.nlm/hook-state/.
 *
 * Logs one JSON line per invocation to ~/.nlm/hook-log.jsonl with
 * `kind: "session-end"` so the daily-digest liveness check can correlate
 * Claude Code session closes against hook fires the same way it does for
 * UserPromptSubmit. Fail-open by design: any error yields a clean exit
 * with no output, so the hook can never block Claude Code shutdown.
 */
export interface SessionEndResult {
    readonly conversationId: string;
    readonly cleared: boolean;
}
export declare function runSessionEnd(conversationId: string): SessionEndResult;
