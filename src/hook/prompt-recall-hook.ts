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
import { classifyPrompt } from "@core/hook/gate.js";
import { appendHookLog } from "@core/hook/hook-log.js";
import { loadSurfaced, recordSurfaced } from "@core/hook/memo.js";
import { formatPointerBlock, type PointerFact } from "@core/hook/pointer-block.js";
import { selectHits, type RecallHitInput } from "@core/hook/select.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { recallOverHttp } from "./recall-over-http.js";

// Keyword recall returns raw BM25 scores (unbounded, not the 0..1 hybrid
// scale). FTS5 MATCH already gates relevance — only lexically-matching
// sessions come back — so the floor starts at 0 and a real cutoff is
// calibrated from the shadow log's score distribution.
const SCORE_THRESHOLD = 0;
const PER_FIRE_CAP = 3;
const PER_CONVERSATION_CAP = 10;
const PROMPT_PREVIEW_CHARS = 200;

export type HookMode = "shadow" | "live";

export interface HookInput {
  readonly prompt: string;
  readonly conversationId: string;
}

export interface RecallFetchResult {
  readonly hits: ReadonlyArray<RecallHitInput>;
  readonly facts: ReadonlyArray<PointerFact>;
}

export interface RunHookDeps {
  readonly mode: HookMode;
  /**
   * Returns hits + optional related facts. Older callers may return a
   * bare hit array; runHook normalizes both shapes.
   */
  readonly recall: (
    prompt: string,
  ) => Promise<ReadonlyArray<RecallHitInput> | RecallFetchResult>;
}

function normalizeRecall(
  raw: ReadonlyArray<RecallHitInput> | RecallFetchResult,
): RecallFetchResult {
  if (Array.isArray(raw)) return { hits: raw, facts: [] };
  return raw as RecallFetchResult;
}

/** Orchestration. Returns the text to emit on stdout ("" for nothing). */
export async function runHook(input: HookInput, deps: RunHookDeps): Promise<string> {
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

  let fetched: RecallFetchResult = { hits: [], facts: [] };
  try {
    fetched = normalizeRecall(await deps.recall(input.prompt));
  } catch {
    fetched = { hits: [], facts: [] };
  }
  const hits = fetched.hits;

  const surfaced = loadSurfaced(input.conversationId);
  const selected = selectHits({
    hits,
    surfaced,
    scoreThreshold: SCORE_THRESHOLD,
    perFireCap: PER_FIRE_CAP,
    perConversationCap: PER_CONVERSATION_CAP,
  });
  const block = formatPointerBlock(selected, fetched.facts);
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

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function main(): Promise<void> {
  try {
    // Load ~/.nlm/.env so NLM_MCP_TOKEN is available before we hit /api/recall.
    // Hooks run as short-lived processes spawned by Claude Code with no shell
    // env beyond what the parent passed — explicit .env load is required.
    autoloadEnv();
    const raw = await readStdin();
    const payload = JSON.parse(raw) as {
      prompt?: unknown;
      session_id?: unknown;
    };
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const conversationId =
      typeof payload.session_id === "string" ? payload.session_id : "unknown";
    if (!prompt) return;

    const mode: HookMode = process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow";
    const out = await runHook(
      { prompt, conversationId },
      { mode, recall: (q) => recallOverHttp(q, "claude-code") },
    );
    if (out) process.stdout.write(out);
  } catch {
    // Fail open — never block or fail a prompt.
  }
}

// Run main() only when invoked directly as a script, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
