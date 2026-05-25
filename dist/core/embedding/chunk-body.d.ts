/**
 * chunk-body — split a session body into ≤MAX_CHUNK_CHARS-char windows
 * for the chunk + max-pool semantic index. Header (label + summary) is
 * prepended to the first chunk so it's always part of the index without
 * inflating later chunk sizes.
 *
 * MAX_CHUNK_CHARS sits below the observed Ollama 8K-char failure cliff
 * for nomic-embed-text; see #172 revert in the 2026-05-25 CHANGELOG.
 * OVERLAP_CHARS preserves context across boundaries so a phrase split
 * mid-chunk still appears intact in one neighboring chunk.
 *
 * Pure function. No I/O, no allocations beyond the returned array.
 */
export declare const MAX_CHUNK_CHARS = 7500;
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
