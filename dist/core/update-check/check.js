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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 4_000;
const PACKAGE_NAME = "nlm-memory";
function defaultCachePath() {
    return (process.env["NLM_UPDATE_CHECK_CACHE"] ??
        join(homedir(), ".nlm", "update-check.json"));
}
function defaultRegistryUrl() {
    return (process.env["NLM_NPM_REGISTRY"] ??
        `https://registry.npmjs.org/${PACKAGE_NAME}/latest`);
}
function isOptedOut() {
    const v = process.env["NLM_DISABLE_UPDATE_CHECK"];
    return v === "1" || v === "true";
}
export async function getUpdateStatus(deps) {
    const now = (deps.now ?? (() => new Date()))();
    const current = deps.currentVersion;
    if (isOptedOut()) {
        return {
            current,
            latest: null,
            behind: false,
            checkedAt: now.toISOString(),
            disabled: "user-opt-out",
        };
    }
    const cachePath = deps.cachePath ?? defaultCachePath();
    const cached = await readCache(cachePath);
    if (cached && now.getTime() - Date.parse(cached.checkedAt) < CACHE_TTL_MS) {
        return {
            current,
            latest: cached.latest,
            behind: cached.latest !== null && isStrictlyNewer(cached.latest, current),
            checkedAt: cached.checkedAt,
        };
    }
    const latest = await fetchLatest(deps.registryUrl ?? defaultRegistryUrl(), deps.fetchImpl ?? fetch);
    const status = {
        current,
        latest,
        behind: latest !== null && isStrictlyNewer(latest, current),
        checkedAt: now.toISOString(),
        ...(latest === null ? { disabled: "unknown-error" } : {}),
    };
    await writeCache(cachePath, {
        current,
        latest,
        checkedAt: status.checkedAt,
    });
    return status;
}
async function readCache(path) {
    try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.checkedAt === "string" &&
            typeof parsed.current === "string" &&
            (parsed.latest === null || typeof parsed.latest === "string")) {
            return {
                current: parsed.current,
                latest: parsed.latest ?? null,
                checkedAt: parsed.checkedAt,
            };
        }
    }
    catch {
        // First run, corrupt cache, or unreadable — treat as cache miss.
    }
    return null;
}
async function writeCache(path, value) {
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(value, null, 2), "utf8");
    }
    catch {
        // Cache failure is non-fatal — the next call just refetches.
    }
}
async function fetchLatest(url, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
    try {
        const r = await fetchImpl(url, {
            signal: controller.signal,
            headers: { accept: "application/json" },
        });
        if (!r.ok)
            return null;
        const body = (await r.json());
        return typeof body.version === "string" ? body.version : null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Strict semver-newer check on simple `X.Y.Z` versions. Pre-release tags
 * (`-rc.1`, `-beta`) sort BEFORE the bare version per semver, which is
 * what we want — a user on `0.6.0-rc.1` should be told `0.6.0` stable
 * is newer.
 */
export function isStrictlyNewer(candidate, current) {
    const parsed = parseSemver(candidate);
    const baseline = parseSemver(current);
    if (!parsed || !baseline)
        return false;
    for (let i = 0; i < 3; i++) {
        const c = parsed.numbers[i] ?? 0;
        const b = baseline.numbers[i] ?? 0;
        if (c > b)
            return true;
        if (c < b)
            return false;
    }
    // Equal core triples — compare prereleases. A bare version beats any
    // prerelease; otherwise sort lexicographically (good enough for our cases).
    if (!parsed.prerelease && baseline.prerelease)
        return true;
    if (parsed.prerelease && !baseline.prerelease)
        return false;
    if (parsed.prerelease && baseline.prerelease) {
        return parsed.prerelease > baseline.prerelease;
    }
    return false;
}
function parseSemver(v) {
    const trimmed = v.trim().replace(/^v/, "");
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(trimmed);
    if (!m)
        return null;
    return {
        numbers: [Number(m[1]), Number(m[2]), Number(m[3])],
        prerelease: m[4] ?? null,
    };
}
//# sourceMappingURL=check.js.map