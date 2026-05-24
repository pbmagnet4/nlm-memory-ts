/**
 * Adds/removes the NLM recall hook entry in a Claude Code settings.json.
 *
 * The nlm entry is identified by its command containing the marker
 * "prompt-recall-hook.js". add is idempotent (it replaces any prior nlm
 * entry); remove strips only the nlm entry and preserves everything else.
 */
/**
 * Single-quote a shell argument so paths with spaces or other shell
 * metacharacters survive `sh -c` tokenization. Without this, a path like
 * `~/projects/...` is split on whitespace
 * and node receives the wrong argv — silent hook bricking.
 */
export declare function shellQuote(arg: string): string;
export declare function buildHookCommand(execPath: string, hookJs: string, mode: "shadow" | "live"): string;
export interface SmokeTestResult {
    readonly ok: boolean;
    readonly reason?: string;
    readonly stderr?: string;
}
/**
 * Invoke the wired command exactly the way Claude Code does (sh -c with
 * JSON on stdin) and confirm the hook log gained an entry. Catches the
 * class of failures where settings.json looks valid but the hook fails
 * at startup (path tokenization, missing modules, etc.).
 */
export declare function smokeTestHookCommand(command: string, hookLogPath: string, timeoutMs?: number): SmokeTestResult;
export type ClaudeHookEvent = "UserPromptSubmit" | "SessionEnd" | "Stop" | "PreCompact" | "PostToolUse" | "PreToolUse";
export declare function addHook(settingsPath: string, command: string, event?: ClaudeHookEvent): void;
/**
 * Remove the NLM-tagged hook entry from one event (default UserPromptSubmit)
 * or every event when `event === "*"`. Leaves unrelated entries untouched.
 */
export declare function removeHook(settingsPath: string, event?: ClaudeHookEvent | "*"): void;
