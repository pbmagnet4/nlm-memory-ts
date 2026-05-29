/**
 * Claude Code SessionStart hook entrypoint for NLM recall.
 *
 * Fires before any prompt in a new session (including cron-fired and background
 * agents that never trigger UserPromptSubmit). Surfaces relevant prior context
 * proactively so cold-start agents aren't recall-blind.
 *
 * Query is derived from working_directory + project_name since no user prompt
 * exists yet — intentionally weaker than prompt-recall, best-effort only.
 *
 * Mirrors prompt-recall-hook.ts shape exactly: same pointer-block format, same
 * memo writes, same NLM_HOOK_MODE semantics.
 */
import { pathToFileURL } from "node:url";
import { appendHookLog } from "../core/hook/hook-log.js";
import { loadSurfaced, recordSurfaced } from "../core/hook/memo.js";
import { formatPointerBlock } from "../core/hook/pointer-block.js";
import { selectHits } from "../core/hook/select.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { hookAuthHeaders } from "./hook-auth.js";
const SCORE_THRESHOLD = 0;
const PER_FIRE_CAP = 3;
const PER_CONVERSATION_CAP = 10;
const RECALL_LIMIT = 5;
const RECALL_TIMEOUT_MS = 2000;
/** Orchestration. Returns the text to emit on stdout ("" for nothing). */
export async function runHook(input, deps) {
    let hits = [];
    try {
        hits = await deps.recall(input.query);
    }
    catch {
        hits = [];
    }
    const surfaced = loadSurfaced(input.conversationId);
    const selected = selectHits({
        hits,
        surfaced,
        scoreThreshold: SCORE_THRESHOLD,
        perFireCap: PER_FIRE_CAP,
        perConversationCap: PER_CONVERSATION_CAP,
    });
    const block = formatPointerBlock(selected);
    const estTokens = Math.ceil(block.length / 4);
    appendHookLog({
        ts: new Date().toISOString(),
        conversationId: input.conversationId,
        promptPreview: input.query,
        gate: "evaluate",
        hits: hits.map((h) => ({ id: h.id, score: h.matchScore })),
        wouldInject: selected.map((h) => h.id),
        estTokens,
        mode: deps.mode,
    });
    if (deps.mode === "live" && selected.length > 0) {
        recordSurfaced(input.conversationId, selected.map((h) => h.id));
        return block;
    }
    return "";
}
/** Derive a best-effort query from SessionStart payload fields. */
function buildQuery(workingDirectory, projectName) {
    const dirTail = workingDirectory.split("/").filter(Boolean).at(-1) ?? "";
    const parts = [dirTail, projectName].filter(Boolean);
    return parts.join(" ").trim() || "session start";
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
async function recallOverHttp(query) {
    const portValue = process.env["NLM_PORT"] ?? "3940";
    const url = `http://localhost:${portValue}/api/recall` +
        `?q=${encodeURIComponent(query)}&mode=hybrid&limit=${RECALL_LIMIT}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: hookAuthHeaders({ "x-recall-source": "session-start-hook" }),
            signal: controller.signal,
        });
        if (!res.ok)
            return [];
        let body;
        try {
            body = (await res.json());
        }
        catch {
            return [];
        }
        return (body.results ?? []).map((r) => ({
            id: r.id,
            label: r.label,
            startedAt: r.startedAt,
            matchScore: r.matchScore,
        }));
    }
    finally {
        clearTimeout(timer);
    }
}
async function main() {
    try {
        autoloadEnv();
        const raw = await readStdin();
        const payload = JSON.parse(raw);
        const conversationId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
        const workingDirectory = typeof payload.cwd === "string"
            ? payload.cwd
            : typeof payload.working_directory === "string"
                ? payload.working_directory
                : "";
        const projectName = typeof payload.project_name === "string" ? payload.project_name : "";
        const query = buildQuery(workingDirectory, projectName);
        const mode = process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow";
        const out = await runHook({ conversationId, query }, { mode, recall: recallOverHttp });
        if (out)
            process.stdout.write(out);
    }
    catch {
        // Fail open — never block or fail a session start.
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main();
}
//# sourceMappingURL=session-start-hook.js.map