/**
 * Idempotent permission hardening for ~/.nlm/.
 *
 * Recursively sets owner-only perms on the daemon's working directory:
 *   directories → 0o700
 *   files       → 0o600
 *
 * Run at every `nlm setup`, `nlm install`, and `nlm start` so installs
 * predating v0.4.2 (when explicit chmod was added) self-heal on next
 * launch. No-op on Windows — ACLs are the POSIX equivalent and out of
 * scope here.
 */

import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PermsHardenResult {
  readonly nlmDir: string;
  readonly filesHardened: number;
  readonly dirsHardened: number;
  readonly skipped: number;
}

export function hardenNlmDirPermissions(
  nlmDir: string = join(homedir(), ".nlm"),
): PermsHardenResult {
  const result = { nlmDir, filesHardened: 0, dirsHardened: 0, skipped: 0 };
  if (process.platform === "win32") return result;
  if (!existsSync(nlmDir)) return result;
  walk(nlmDir, result);
  return result;
}

interface MutableResult {
  filesHardened: number;
  dirsHardened: number;
  skipped: number;
}

function walk(path: string, r: MutableResult): void {
  try {
    const s = statSync(path);
    if (s.isDirectory()) {
      chmodSync(path, 0o700);
      r.dirsHardened += 1;
      for (const name of readdirSync(path)) walk(join(path, name), r);
    } else if (s.isFile()) {
      chmodSync(path, 0o600);
      r.filesHardened += 1;
    }
  } catch {
    r.skipped += 1;
  }
}
