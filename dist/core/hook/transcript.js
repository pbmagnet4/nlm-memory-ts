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
import { existsSync, readFileSync } from "node:fs";
const EMPTY_TURN = { text: "", toolUses: [] };
function parseTurn(parsed) {
    if (parsed.type !== "assistant" || !parsed.message)
        return null;
    const content = parsed.message.content;
    if (typeof content === "string") {
        return content ? { text: content, toolUses: [] } : null;
    }
    if (!Array.isArray(content))
        return null;
    const textParts = [];
    const toolUses = [];
    for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
        }
        else if (block.type === "tool_use" && typeof block.name === "string") {
            toolUses.push({ name: block.name, input: block.input });
        }
    }
    if (textParts.length === 0 && toolUses.length === 0)
        return null;
    return { text: textParts.join("\n"), toolUses };
}
function readLines(transcriptPath) {
    if (!transcriptPath || !existsSync(transcriptPath))
        return null;
    try {
        return readFileSync(transcriptPath, "utf8").split("\n");
    }
    catch {
        return null;
    }
}
export function readAllAssistantTurns(transcriptPath) {
    const lines = readLines(transcriptPath);
    if (!lines)
        return [];
    const turns = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        const turn = parseTurn(parsed);
        if (turn)
            turns.push(turn);
    }
    return turns;
}
export function readLastAssistantTurn(transcriptPath) {
    const lines = readLines(transcriptPath);
    if (!lines)
        return EMPTY_TURN;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        const turn = parseTurn(parsed);
        if (turn)
            return turn;
    }
    return EMPTY_TURN;
}
/** Back-compat shim for callers that only need prose. */
export function readLastAssistantText(transcriptPath) {
    const turn = readLastAssistantTurn(transcriptPath);
    return turn.text || null;
}
//# sourceMappingURL=transcript.js.map