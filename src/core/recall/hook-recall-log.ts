/**
 * Reader for the prompt-recall hook's surfaced-set entries in
 * ~/.nlm/hook-log.jsonl. Unlike query_log.jsonl, hook-log entries reliably
 * carry the real conversationId (Claude Code session_id) alongside the
 * injected ids — making it the correct join substrate for recall precision.
 *
 * Only `recall` entries (those with a wouldInject array) are surfaced events.
 * The file also holds stop / session-end / pre-compact / subagent-start
 * entries, which this reader ignores.
 *
 * Read-only telemetry path — never raises.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HookRecallEntry {
  readonly conversationId: string;
  readonly injectedIds: ReadonlyArray<string>;
}

function defaultLogPath(): string {
  return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}

export async function readHookRecallLog(
  days: number,
  logPath: string = defaultLogPath(),
): Promise<HookRecallEntry[]> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const results: HookRecallEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!Array.isArray(obj["wouldInject"])) continue;
    if (typeof obj["ts"] !== "string" || Date.parse(obj["ts"]) < cutoff) continue;
    const conversationId = typeof obj["conversationId"] === "string" ? obj["conversationId"] : "unknown";
    if (conversationId === "unknown") continue;
    const injectedIds = obj["wouldInject"].filter((x): x is string => typeof x === "string");
    if (injectedIds.length === 0) continue;
    results.push({ conversationId, injectedIds });
  }
  return results;
}
