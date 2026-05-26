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

export const MAX_CHUNK_CHARS = 5_500;
export const OVERLAP_CHARS = 500;

export interface ChunkInput {
  readonly label?: string | null;
  readonly summary?: string | null;
  readonly body?: string | null;
}

export interface ChunkOptions {
  readonly maxChars?: number;
  readonly overlap?: number;
}

export function chunkSessionText(
  input: ChunkInput,
  opts: ChunkOptions = {},
): string[] {
  const maxChars = opts.maxChars ?? MAX_CHUNK_CHARS;
  const overlap = opts.overlap ?? OVERLAP_CHARS;
  if (maxChars <= 0) throw new Error("chunkSessionText: maxChars must be > 0");
  if (overlap < 0 || overlap >= maxChars) {
    throw new Error("chunkSessionText: overlap must satisfy 0 <= overlap < maxChars");
  }

  const header = [input.label ?? "", input.summary ?? ""]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(" ");
  const body = (input.body ?? "").trim();

  if (!header && !body) return [];
  if (!body) return [header];

  // First chunk: header + as much body as fits.
  const headerPrefix = header ? header + " " : "";
  const firstBodyBudget = Math.max(1, maxChars - headerPrefix.length);

  if (body.length <= firstBodyBudget) {
    return [(headerPrefix + body).trim()];
  }

  const chunks: string[] = [];
  chunks.push((headerPrefix + body.slice(0, firstBodyBudget)).trim());

  // Subsequent chunks: body windows with overlap.
  const step = maxChars - overlap;
  let pos = Math.max(0, firstBodyBudget - overlap);
  while (pos < body.length) {
    const end = Math.min(pos + maxChars, body.length);
    const slice = body.slice(pos, end).trim();
    if (slice.length > 0) chunks.push(slice);
    if (end >= body.length) break;
    pos += step;
  }
  return chunks;
}
