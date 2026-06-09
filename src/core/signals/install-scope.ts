/**
 * Per-install scope id. Generated once, persisted at ~/.nlm/install-id, and
 * stamped on every signal so recall can isolate signals to the local install
 * even when an instance is shared over Tailscale. Memoized per process.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

let cached: string | null = null;

export function installScope(path = join(homedir(), ".nlm", "install-id")): string {
  if (cached) return cached;
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8").trim();
      if (existing) { cached = existing; return existing; }
    }
  } catch {
    // unreadable - fall through and try to (re)generate
  }
  const id = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${id}\n`, { mode: 0o600 });
  } catch {
    // best-effort persist; the in-process cache still keeps it stable this run
  }
  cached = id;
  return id;
}

/** Test-only: drop the process memo so a fresh path is read. */
export function resetInstallScopeCache(): void {
  cached = null;
}
