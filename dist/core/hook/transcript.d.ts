/**
 * Read assistant messages from a Claude Code transcript JSONL.
 *
 * Claude Code passes `transcript_path` in the Stop hook payload. Each line is
 * a JSON object; assistant turns have `type:"assistant"` and a `message`
 * object whose `content` is an array of blocks (`{type:"text", text:...}` for
 * prose; `{type:"tool_use", name, input}` for tool invocations).
 *
 * Stop-hook citation detection needs the union of ALL assistant turns in the
 * transcript, not just the last one: the model typically calls a tool, reads
 * the result on the next user turn (tool_result), then writes a prose summary
 * as a separate assistant turn. Scanning only the last turn misses the
 * tool_use entirely. `readAllAssistantTurns` returns every assistant turn in
 * order so the detector can fire across the whole conversation; cross-firing
 * dedup happens upstream via the per-conversation cited memo.
 *
 * Fail-quiet: a malformed file yields nulls/empty rather than throwing —
 * the Stop hook must never break on transcript I/O.
 */
export interface ToolUseBlock {
    readonly name: string;
    readonly input: unknown;
}
export interface AssistantTurn {
    readonly text: string;
    readonly toolUses: ReadonlyArray<ToolUseBlock>;
}
export declare function readAllAssistantTurns(transcriptPath: string): ReadonlyArray<AssistantTurn>;
export declare function readLastAssistantTurn(transcriptPath: string): AssistantTurn;
/** Back-compat shim for callers that only need prose. */
export declare function readLastAssistantText(transcriptPath: string): string | null;
