/**
 * Per-conversation dedup memo for the recall hook. One JSON file per
 * conversation holds the set of session ids already surfaced, so each is
 * surfaced at most once per conversation.
 *
 * State dir defaults to ~/.nlm/hook-state/, overridable via
 * NLM_HOOK_STATE_DIR (testability — mirrors query-log.ts).
 *
 * Every function is defensive: a missing or corrupt file yields an empty
 * memo, and a write failure is swallowed. The hook must never break on memo
 * I/O.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function stateDir(): string {
  return process.env["NLM_HOOK_STATE_DIR"] ?? join(homedir(), ".nlm", "hook-state");
}

function memoPath(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return join(stateDir(), `${safe}.json`);
}

export function loadSurfaced(conversationId: string): Set<string> {
  try {
    const path = memoPath(conversationId);
    if (!existsSync(path)) return new Set();
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function recordSurfaced(
  conversationId: string,
  ids: ReadonlyArray<string>,
): void {
  try {
    const merged = loadSurfaced(conversationId);
    for (const id of ids) merged.add(id);
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(memoPath(conversationId), JSON.stringify([...merged]), "utf8");
  } catch {
    // Memo write failure must never break the hook.
  }
}

/**
 * Delete the memo file for a closed conversation. Called by the SessionEnd
 * hook so memo files don't accumulate forever. Returns true if a file was
 * removed, false otherwise — callers may want to log the outcome.
 */
export function clearSurfaced(conversationId: string): boolean {
  try {
    const path = memoPath(conversationId);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}
