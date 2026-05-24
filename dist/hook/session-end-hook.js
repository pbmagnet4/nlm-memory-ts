/**
 * Claude Code SessionEnd hook entrypoint for NLM.
 *
 * Fires when a Claude Code session closes. Deletes the per-conversation
 * memo file written during the session so memo files don't accumulate
 * indefinitely under ~/.nlm/hook-state/.
 *
 * Logs one JSON line per invocation to ~/.nlm/hook-log.jsonl with
 * `kind: "session-end"` so the daily-digest liveness check can correlate
 * Claude Code session closes against hook fires the same way it does for
 * UserPromptSubmit. Fail-open by design: any error yields a clean exit
 * with no output, so the hook can never block Claude Code shutdown.
 */
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { clearSurfaced } from "../core/hook/memo.js";
export function runSessionEnd(conversationId) {
    const cleared = clearSurfaced(conversationId);
    return { conversationId, cleared };
}
function readStdin() {
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", () => resolve(data));
    });
}
function logPath() {
    return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}
function logSessionEnd(result) {
    try {
        const path = logPath();
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify({
            ts: new Date().toISOString(),
            kind: "session-end",
            conversationId: result.conversationId,
            cleared: result.cleared,
            mode: process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow",
        })}\n`, "utf8");
    }
    catch {
        // Telemetry failure must never break the hook.
    }
}
async function main() {
    try {
        const raw = await readStdin();
        const payload = JSON.parse(raw);
        const conversationId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
        logSessionEnd(runSessionEnd(conversationId));
    }
    catch {
        // Fail open — never block Claude Code shutdown.
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main();
}
//# sourceMappingURL=session-end-hook.js.map