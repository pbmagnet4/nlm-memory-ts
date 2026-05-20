/**
 * Shared utilities for TranscriptAdapter implementations.
 *
 * Only functions that genuinely serve multiple adapters live here. Adapter-
 * specific logic (content extraction, file-shape detection, dedup) stays
 * with the adapter.
 */
export declare function normalizeTimestamp(ts: unknown): string;
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
export declare function safeSessionId(prefix: string, rawId: string): string;
export declare function durationMinutes(startedAt: string, endedAt: string): number;
