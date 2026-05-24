/**
 * Adds/removes the NLM recall hook entry in a Claude Code settings.json.
 *
 * The nlm entry is identified by its command containing the marker
 * "prompt-recall-hook.js". add is idempotent (it replaces any prior nlm
 * entry); remove strips only the nlm entry and preserves everything else.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

// Every NLM hook script ends in `-hook.js`. We tag entries we own by
// matching the filename suffix against this list. Add new entries here
// when a new hook script ships.
const HOOK_SCRIPT_MARKERS = [
  "prompt-recall-hook.js",
  "session-end-hook.js",
] as const;

/**
 * Single-quote a shell argument so paths with spaces or other shell
 * metacharacters survive `sh -c` tokenization. Without this, a path like
 * `~/projects/...` is split on whitespace
 * and node receives the wrong argv — silent hook bricking.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function buildHookCommand(
  execPath: string,
  hookJs: string,
  mode: "shadow" | "live",
): string {
  return `NLM_HOOK_MODE=${mode} ${shellQuote(execPath)} ${shellQuote(hookJs)}`;
}

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
export function smokeTestHookCommand(
  command: string,
  hookLogPath: string,
  timeoutMs = 5000,
): SmokeTestResult {
  const sizeBefore = existsSync(hookLogPath) ? statSync(hookLogPath).size : 0;
  const result = spawnSync("sh", ["-c", command], {
    input: JSON.stringify({ prompt: "smoke test", session_id: "install-smoke" }),
    timeout: timeoutMs,
    encoding: "utf8",
  });
  if (result.error) {
    return { ok: false, reason: `spawn failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `exit code ${result.status ?? "null"}`,
      stderr: result.stderr,
    };
  }
  const sizeAfter = existsSync(hookLogPath) ? statSync(hookLogPath).size : 0;
  if (sizeAfter <= sizeBefore) {
    return {
      ok: false,
      reason: `no entry appended to ${hookLogPath}`,
      stderr: result.stderr,
    };
  }
  return { ok: true };
}

export type ClaudeHookEvent =
  | "UserPromptSubmit"
  | "SessionEnd"
  | "Stop"
  | "PreCompact"
  | "PostToolUse"
  | "PreToolUse";

interface HookCommand {
  readonly type: string;
  readonly command: string;
}
interface HookEntry {
  readonly hooks: ReadonlyArray<HookCommand>;
}
interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

function read(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Claude settings at ${path} is not a JSON object`);
  }
  return parsed as ClaudeSettings;
}

function write(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function isNlmEntry(entry: HookEntry): boolean {
  return entry.hooks.some((h) =>
    HOOK_SCRIPT_MARKERS.some((marker) => h.command.includes(marker)),
  );
}

export function addHook(
  settingsPath: string,
  command: string,
  event: ClaudeHookEvent = "UserPromptSubmit",
): void {
  const settings = read(settingsPath);
  const hooks = settings.hooks ?? {};
  const existing = hooks[event] ?? [];
  const others = existing.filter((e) => !isNlmEntry(e));
  const next: HookEntry[] = [
    ...others,
    { hooks: [{ type: "command", command }] },
  ];
  write(settingsPath, { ...settings, hooks: { ...hooks, [event]: next } });
}

/**
 * Remove the NLM-tagged hook entry from one event (default UserPromptSubmit)
 * or every event when `event === "*"`. Leaves unrelated entries untouched.
 */
export function removeHook(
  settingsPath: string,
  event: ClaudeHookEvent | "*" = "UserPromptSubmit",
): void {
  if (!existsSync(settingsPath)) return;
  const settings = read(settingsPath);
  const allHooks = settings.hooks ?? {};
  const events: string[] = event === "*" ? Object.keys(allHooks) : [event];
  const nextHooks: Record<string, HookEntry[]> = { ...allHooks };
  for (const ev of events) {
    const existing = nextHooks[ev];
    if (!existing) continue;
    const kept = existing.filter((e) => !isNlmEntry(e));
    if (kept.length > 0) nextHooks[ev] = kept;
    else delete nextHooks[ev];
  }
  write(settingsPath, { ...settings, hooks: nextHooks });
}
