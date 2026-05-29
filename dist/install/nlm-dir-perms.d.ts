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
export interface PermsHardenResult {
    readonly nlmDir: string;
    readonly filesHardened: number;
    readonly dirsHardened: number;
    readonly skipped: number;
}
export declare function hardenNlmDirPermissions(nlmDir?: string): PermsHardenResult;
