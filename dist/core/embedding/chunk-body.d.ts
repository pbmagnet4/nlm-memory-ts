/**
 * chunk-body — split a session body into ≤MAX_CHUNK_CHARS-char windows
 * for the chunk + max-pool semantic index. Header (label + summary) is
 * prepended to the first chunk so it's always part of the index without
 * inflating later chunk sizes.
 *
 * MAX_CHUNK_CHARS sized for nomic-embed-text's 2048-token context. Char
 * density varies by content: prose ~4 chars/token, code/tool-output ~3
 * chars/token. The 2026-05-26 backfill bisect found the cliff at ~6,388
 * chars for token-dense Claude Code session bodies — 5,500 holds a safe
 * margin and eliminates the "input exceeds context length" 500s that
 * drove ~76% per-chunk rejection at 7,500. See 2026-05-26 CHANGELOG.
 *
 * OVERLAP_CHARS preserves context across boundaries so a phrase split
 * mid-chunk still appears intact in one neighboring chunk.
 *
 * Pure function. No I/O, no allocations beyond the returned array.
 */
export declare const MAX_CHUNK_CHARS = 5500;
export declare const OVERLAP_CHARS = 500;
export interface ChunkInput {
    readonly label?: string | null;
    readonly summary?: string | null;
    readonly body?: string | null;
}
export interface ChunkOptions {
    readonly maxChars?: number;
    readonly overlap?: number;
}
export declare function chunkSessionText(input: ChunkInput, opts?: ChunkOptions): string[];
