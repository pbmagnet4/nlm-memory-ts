/**
 * Update-check — daily passive poll of the public npm registry to surface
 * "you're on 0.5.X, latest is 0.5.8" without breaking the local-first /
 * no-telemetry spine.
 *
 * What this is: a single unauthenticated GET against
 * https://registry.npmjs.org/nlm-memory/latest. The request transmits no
 * user data; it's the same surface `npm install` already touches.
 *
 * What this is not: a callback to a Whtnxt-owned server, an analytics
 * pixel, or anything that tells us who's running NLM. We don't get to
 * know that, and we don't want to.
 *
 * Caching: result is persisted to ~/.nlm/update-check.json with a 24h
 * TTL. Within the TTL, callers read the cache instead of re-hitting the
 * registry. Opt-out: set NLM_DISABLE_UPDATE_CHECK=1.
 *
 * Failure mode: every error path returns a `disabled` or `unknown` shape
 * — never throws. A daemon that can't reach npm continues to function
 * normally; the user just doesn't see an update banner.
 */
export interface UpdateStatus {
    /** Version currently installed (read from the daemon's own package.json). */
    readonly current: string;
    /** Latest version on the npm `latest` dist-tag, or null if unknown. */
    readonly latest: string | null;
    /** True only when latest is known and strictly newer than current. */
    readonly behind: boolean;
    /** ISO timestamp of the last successful (or attempted) registry read. */
    readonly checkedAt: string;
    /** Set when the user opted out via env var, or the package name is private. */
    readonly disabled?: "user-opt-out" | "unknown-error";
}
/** Returns the current installed version. Callers inject this so the daemon
 *  reads its own package.json once at boot and threads the string through. */
export interface UpdateCheckDeps {
    readonly currentVersion: string;
    readonly cachePath?: string;
    readonly registryUrl?: string;
    readonly now?: () => Date;
    readonly fetchImpl?: typeof fetch;
}
export declare function getUpdateStatus(deps: UpdateCheckDeps): Promise<UpdateStatus>;
/**
 * Strict semver-newer check on simple `X.Y.Z` versions. Pre-release tags
 * (`-rc.1`, `-beta`) sort BEFORE the bare version per semver, which is
 * what we want — a user on `0.6.0-rc.1` should be told `0.6.0` stable
 * is newer.
 */
export declare function isStrictlyNewer(candidate: string, current: string): boolean;
