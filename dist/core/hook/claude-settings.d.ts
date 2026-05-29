/**
 * Adds/removes NLM hook entries in a Claude Code settings.json.
 *
 * NLM-owned entries are identified by HOOK_SCRIPT_MARKERS. add is idempotent
 * (replaces any prior NLM entry for the same event); remove strips only NLM
 * entries and preserves everything else.
 */
/**
 * Single-quote a shell argument so paths with spaces or other shell
 * metacharacters survive `sh -c` tokenization. Without this, a path like
 * `~/projects/...` is split on whitespace
 * and node receives the wrong argv — silent hook bricking.
 */
export declare function shellQuote(arg: string): string;
/**
 * Double-quote a cmd.exe argument. Embedded double quotes are doubled per
 * cmd.exe parsing rules. Used for hook commands on Windows where Claude
 * Code dispatches via cmd.exe /c rather than sh -c.
 */
export declare function cmdQuote(arg: string): string;
export declare function buildHookCommand(execPath: string, hookJs: string, mode: "shadow" | "live", targetPlatform?: NodeJS.Platform): string;
export interface SmokeTestResult {
    readonly ok: boolean;
    readonly reason?: string;
    readonly stderr?: string;
}
/**
 * Invoke the wired command exactly the way Claude Code does (sh -c on
 * POSIX, cmd.exe /c on Windows) with JSON on stdin and confirm the hook
 * log gained an entry. Catches the class of failures where settings.json
 * looks valid but the hook fails at startup (path tokenization, missing
 * modules, missing shell, etc.).
 */
export declare function smokeTestHookCommand(command: string, hookLogPath: string, timeoutMs?: number): SmokeTestResult;
export type ClaudeHookEvent = "UserPromptSubmit" | "SessionStart" | "SessionEnd" | "Stop" | "PreCompact" | "SubagentStart" | "PostToolUse" | "PreToolUse";
export declare function addHook(settingsPath: string, command: string, event?: ClaudeHookEvent): void;
/**
 * Remove the NLM-tagged hook entry from one event (default UserPromptSubmit)
 * or every event when `event === "*"`. Leaves unrelated entries untouched.
 */
export declare function removeHook(settingsPath: string, event?: ClaudeHookEvent | "*"): void;
