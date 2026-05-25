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
import { existsSync, readFileSync } from "node:fs";
export function readLastAssistantText(transcriptPath) {
    if (!transcriptPath || !existsSync(transcriptPath))
        return null;
    let raw;
    try {
        raw = readFileSync(transcriptPath, "utf8");
    }
    catch {
        return null;
    }
    const lines = raw.split("\n");
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
        if (parsed.type !== "assistant" || !parsed.message)
            continue;
        const content = parsed.message.content;
        if (typeof content === "string")
            return content;
        if (Array.isArray(content)) {
            const parts = [];
            for (const block of content) {
                if (block.type === "text" && typeof block.text === "string") {
                    parts.push(block.text);
                }
            }
            if (parts.length > 0)
                return parts.join("\n");
        }
    }
    return null;
}
//# sourceMappingURL=transcript.js.map