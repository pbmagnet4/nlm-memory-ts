/**
 * Read the last assistant message text from a Claude Code transcript JSONL.
 *
 * Claude Code passes `transcript_path` in the Stop hook payload. Each line is
 * a JSON object; assistant turns have `type:"assistant"` and a `message`
 * object whose `content` is an array of blocks (`{type:"text", text:...}`
 * for prose; tool_use/tool_result blocks are ignored).
 *
 * Returns the concatenated text of the last assistant message, or null if
 * the file is missing/unreadable/empty/has no assistant turn. Fail-quiet:
 * a malformed file yields null rather than throwing — the Stop hook must
 * never break on transcript I/O.
 */
export declare function readLastAssistantText(transcriptPath: string): string | null;
