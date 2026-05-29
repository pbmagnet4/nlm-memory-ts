/**
 * Claude Code UserPromptSubmit hook entrypoint for NLM recall.
 *
 * runHook is the testable orchestration; main() is the thin process wrapper
 * (stdin / stdout / fetch / env). Every path is fail-open: any error yields
 * no output and a clean exit, so the hook can never block or fail a prompt.
 *
 * Mode is read from NLM_HOOK_MODE (default "shadow"). In shadow mode the
 * hook logs what it would inject and emits nothing; in live mode it emits a
 * pointer block and records the per-conversation memo.
 */
import { pathToFileURL } from "node:url";
import { classifyPrompt } from "../core/hook/gate.js";
import { appendHookLog } from "../core/hook/hook-log.js";
import { loadSurfaced, recordSurfaced } from "../core/hook/memo.js";
import { formatPointerBlock } from "../core/hook/pointer-block.js";
import { selectHits } from "../core/hook/select.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { hookAuthHeaders } from "./hook-auth.js";
// Keyword recall returns raw BM25 scores (unbounded, not the 0..1 hybrid
// scale). FTS5 MATCH already gates relevance — only lexically-matching
// sessions come back — so the floor starts at 0 and a real cutoff is
// calibrated from the shadow log's score distribution.
const SCORE_THRESHOLD = 0;
const PER_FIRE_CAP = 3;
const PER_CONVERSATION_CAP = 10;
const RECALL_LIMIT = 5; // fetch more than PER_FIRE_CAP to absorb score-filter + dedup
const RECALL_TIMEOUT_MS = 2000; // keyword recall is ~400ms warm, ~1.4s cold
const PROMPT_PREVIEW_CHARS = 200;
/** Orchestration. Returns the text to emit on stdout ("" for nothing). */
export async function runHook(input, deps) {
    const gate = classifyPrompt(input.prompt);
    const preview = input.prompt.slice(0, PROMPT_PREVIEW_CHARS);
    if (gate === "generative") {
        appendHookLog({
            ts: new Date().toISOString(),
            conversationId: input.conversationId,
            promptPreview: preview,
            gate,
            hits: [],
            wouldInject: [],
            estTokens: 0,
            mode: deps.mode,
        });
        return "";
    }
    let hits = [];
    try {
        hits = await deps.recall(input.prompt);
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
        promptPreview: preview,
        gate,
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
function readStdin() {
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", () => resolve(data));
    });
}
async function recallOverHttp(prompt) {
    const portValue = process.env["NLM_PORT"] ?? "3940";
    // keyword (FTS5) not hybrid: hybrid's Ollama embedding round-trip takes
    // ~5s, far too slow for a hook that blocks prompt submission.
    const url = `http://localhost:${portValue}/api/recall` +
        `?q=${encodeURIComponent(prompt)}&mode=keyword&limit=${RECALL_LIMIT}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: hookAuthHeaders({ "x-recall-source": "hook" }),
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
        // Load ~/.nlm/.env so NLM_MCP_TOKEN is available before we hit /api/recall.
        // Hooks run as short-lived processes spawned by Claude Code with no shell
        // env beyond what the parent passed — explicit .env load is required.
        autoloadEnv();
        const raw = await readStdin();
        const payload = JSON.parse(raw);
        const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
        const conversationId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
        if (!prompt)
            return;
        const mode = process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow";
        const out = await runHook({ prompt, conversationId }, { mode, recall: recallOverHttp });
        if (out)
            process.stdout.write(out);
    }
    catch {
        // Fail open — never block or fail a prompt.
    }
}
// Run main() only when invoked directly as a script, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main();
}
//# sourceMappingURL=prompt-recall-hook.js.map