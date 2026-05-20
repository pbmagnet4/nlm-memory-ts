/**
 * Shared utilities for TranscriptAdapter implementations.
 *
 * Only functions that genuinely serve multiple adapters live here. Adapter-
 * specific logic (content extraction, file-shape detection, dedup) stays
 * with the adapter.
 */
export function normalizeTimestamp(ts) {
    if (ts === null || ts === undefined || ts === "" || ts === 0)
        return "";
    if (typeof ts === "string")
        return ts;
    if (typeof ts === "number" && Number.isFinite(ts)) {
        let secs = ts;
        // Detect millisecond magnitude (Unix-millis are > 1e10 through ~2286)
        if (secs > 1e10)
            secs = secs / 1000;
        try {
            return new Date(secs * 1000).toISOString();
        }
        catch {
            return "";
        }
    }
    return String(ts);
}
/**
 * Build a collision-resistant session ID for an adapter prefix.
 *
 * Strategy (matches Python _common.safe_session_id):
 *   1. If raw_id has 3+ underscore-delimited parts (e.g. Hermes
 *      `YYYYMMDD_HHMMSS_HHHHHH`), use `${prefix}_${parts[0]}_${parts.at(-1)}`
 *      — date + unique suffix.
 *   2. Otherwise (UUID-style or opaque), return `${prefix}_${rawId}` verbatim;
 *      the caller is responsible for global uniqueness.
 */
export function safeSessionId(prefix, rawId) {
    if (!rawId)
        return prefix;
    const parts = rawId.split("_");
    if (parts.length >= 3) {
        return `${prefix}_${parts[0]}_${parts[parts.length - 1]}`;
    }
    return `${prefix}_${rawId}`;
}
export function durationMinutes(startedAt, endedAt) {
    if (!startedAt || !endedAt)
        return 0;
    try {
        const s = Date.parse(startedAt);
        const e = Date.parse(endedAt);
        if (!Number.isFinite(s) || !Number.isFinite(e))
            return 0;
        return Math.max(0, Math.trunc((e - s) / 60_000));
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=common.js.map