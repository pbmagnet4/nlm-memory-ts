/**
 * Claude Code Stop hook entrypoint for NLM.
 *
 * Fires after the model finishes a response. Scans the last assistant message
 * in the transcript for substrings matching any session ID the recall hook
 * surfaced this conversation (via the dedup memo). Each match becomes a
 * citation event posted to the daemon at POST /api/recall/cite-event.
 *
 * Double duty:
 *  - Per-recall useful_hit_rate metric (was the returned ID actually used?)
 *  - Training-data substrate for a learned reranker (was_cited per query)
 *
 * Fail-open by design: any error yields a clean exit with no output. The
 * Stop hook can never block Claude Code's response. The smoke test path
 * succeeds even with missing transcript_path because the hook always logs
 * a `kind:"stop"` line.
 */
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detectCitations, } from "../core/hook/citation-detect.js";
import { loadSurfaced } from "../core/hook/memo.js";
import { loadCited, recordCited } from "../core/hook/cite-memo.js";
import { readAllAssistantTurns, } from "../core/hook/transcript.js";
const RESPONSE_PREVIEW_CHARS = 200;
const POST_TIMEOUT_MS = 1500;
export async function runStopHook(input, deps) {
    // stop_hook_active=true means Stop is firing again because a prior Stop
    // hook returned control to the model. Skip to avoid double-counting.
    if (input.stopHookActive) {
        return {
            conversationId: input.conversationId,
            surfacedCount: 0,
            citations: [],
            responsePreview: "",
            skipped: true,
        };
    }
    const surfaced = loadSurfaced(input.conversationId);
    if (surfaced.size === 0) {
        return {
            conversationId: input.conversationId,
            surfacedCount: 0,
            citations: [],
            responsePreview: "",
            skipped: false,
        };
    }
    const turns = readAllAssistantTurns(input.transcriptPath);
    if (turns.length === 0) {
        return {
            conversationId: input.conversationId,
            surfacedCount: surfaced.size,
            citations: [],
            responsePreview: "",
            skipped: false,
        };
    }
    const allToolUses = [];
    const textParts = [];
    for (const turn of turns) {
        if (turn.text)
            textParts.push(turn.text);
        for (const tu of turn.toolUses)
            allToolUses.push(tu);
    }
    const unionText = textParts.join("\n");
    const detected = detectCitations({
        responseText: unionText,
        toolUses: allToolUses,
        surfacedIds: surfaced,
    });
    const alreadyCited = loadCited(input.conversationId);
    const fresh = detected.filter((c) => !alreadyCited.has(c.id));
    // Preview is the LAST turn's prose — that's what Edward saw when Stop
    // fired. Stable substrate for the citation log even when detection
    // ranges across earlier turns.
    const lastText = turns[turns.length - 1]?.text ?? "";
    const preview = lastText.slice(0, RESPONSE_PREVIEW_CHARS);
    for (const c of fresh) {
        try {
            await deps.postCitation(input.conversationId, c.id, c.kind, preview);
        }
        catch {
            // Daemon down or HTTP error — local memo update below still records
            // the citation so we don't repost on the next Stop fire.
        }
    }
    if (fresh.length > 0) {
        recordCited(input.conversationId, fresh.map((c) => c.id));
    }
    return {
        conversationId: input.conversationId,
        surfacedCount: surfaced.size,
        citations: fresh,
        responsePreview: preview,
        skipped: false,
    };
}
function logPath() {
    return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}
function logStopResult(result) {
    try {
        const path = logPath();
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify({
            ts: new Date().toISOString(),
            kind: "stop",
            conversationId: result.conversationId,
            surfacedCount: result.surfacedCount,
            citedIds: result.citations.map((c) => c.id),
            citationKinds: result.citations.map((c) => c.kind),
            skipped: result.skipped,
            mode: process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow",
        })}\n`, "utf8");
    }
    catch {
        // Telemetry failure must never break the hook.
    }
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
async function postCitationOverHttp(conversationId, citedId, kind, responsePreview) {
    const port = process.env["NLM_PORT"] ?? "3940";
    const url = `http://localhost:${port}/api/recall/cite-event`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
        await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversation_id: conversationId,
                cited_id: citedId,
                kind,
                response_preview: responsePreview,
            }),
            signal: controller.signal,
        });
    }
    finally {
        clearTimeout(timer);
    }
}
async function main() {
    try {
        const raw = await readStdin();
        const payload = JSON.parse(raw);
        const conversationId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
        const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
        const stopHookActive = payload.stop_hook_active === true;
        const result = await runStopHook({ conversationId, transcriptPath, stopHookActive }, { postCitation: postCitationOverHttp });
        logStopResult(result);
    }
    catch {
        // Fail open — never block Claude Code's response.
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main();
}
//# sourceMappingURL=stop-hook.js.map