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
import { appendHookLog } from "@core/hook/hook-log.js";
import { loadSurfaced, recordSurfaced } from "@core/hook/memo.js";
import { formatPointerBlock } from "@core/hook/pointer-block.js";
import { selectHits, type RecallHitInput } from "@core/hook/select.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { hookAuthHeaders } from "./hook-auth.js";

const SCORE_THRESHOLD = 0;
const PER_FIRE_CAP = 3;
const PER_CONVERSATION_CAP = 10;
const RECALL_LIMIT = 5;
const RECALL_TIMEOUT_MS = 2000;

export type HookMode = "shadow" | "live";

export interface SessionStartInput {
  readonly conversationId: string;
  readonly query: string;
}

export interface RunSessionStartDeps {
  readonly mode: HookMode;
  readonly recall: (query: string, conversationId?: string) => Promise<ReadonlyArray<RecallHitInput>>;
}

/** Orchestration. Returns the text to emit on stdout ("" for nothing). */
export async function runHook(
  input: SessionStartInput,
  deps: RunSessionStartDeps,
): Promise<string> {
  let hits: ReadonlyArray<RecallHitInput> = [];
  try {
    hits = await deps.recall(input.query, input.conversationId);
  } catch {
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

/** Join the failure-mode block (if any) above the session-recall block. */
export function composeSessionStartOutput(failureModeBlock: string, recallBlock: string): string {
  return [failureModeBlock, recallBlock].filter((s) => s.length > 0).join("\n\n");
}

async function fetchFailureModeBlock(repo: string): Promise<string> {
  if (!repo) return "";
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url = `http://localhost:${portValue}/api/signals/failure-modes?repo=${encodeURIComponent(repo)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: hookAuthHeaders({ "x-recall-source": "session-start-hook" }),
      signal: controller.signal,
    });
    if (!res.ok) return "";
    const body = (await res.json()) as { block?: string };
    return typeof body.block === "string" ? body.block : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Derive a best-effort query from SessionStart payload fields. */
function buildQuery(workingDirectory: string, projectName: string): string {
  const dirTail = workingDirectory.split("/").filter(Boolean).at(-1) ?? "";
  const parts = [dirTail, projectName].filter(Boolean);
  return parts.join(" ").trim() || "session start";
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

async function recallOverHttp(query: string, conversationId?: string): Promise<ReadonlyArray<RecallHitInput>> {
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url =
    `http://localhost:${portValue}/api/recall` +
    `?q=${encodeURIComponent(query)}&mode=hybrid&limit=${RECALL_LIMIT}` +
    (conversationId ? `&conversation_id=${encodeURIComponent(conversationId)}` : "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: hookAuthHeaders({
        "x-recall-source": "session-start-hook",
        "x-recall-runtime": "claude-code",
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    type RecallBody = {
      results?: ReadonlyArray<{
        id: string;
        label: string;
        startedAt: string;
        matchScore: number;
        summary?: string;
      }>;
    };
    let body: RecallBody;
    try {
      body = (await res.json()) as RecallBody;
    } catch {
      return [];
    }
    return (body.results ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      startedAt: r.startedAt,
      matchScore: r.matchScore,
      ...(r.summary !== undefined ? { summary: r.summary } : {}),
    }));
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  try {
    autoloadEnv();
    const raw = await readStdin();
    const payload = JSON.parse(raw) as {
      session_id?: unknown;
      cwd?: unknown;
      working_directory?: unknown;
      project_name?: unknown;
    };
    const conversationId =
      typeof payload.session_id === "string" ? payload.session_id : "unknown";
    const workingDirectory =
      typeof payload.cwd === "string"
        ? payload.cwd
        : typeof payload.working_directory === "string"
          ? payload.working_directory
          : "";
    const projectName =
      typeof payload.project_name === "string" ? payload.project_name : "";
    const query = buildQuery(workingDirectory, projectName);
    const mode: HookMode = process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow";
    const out = await runHook({ conversationId, query }, { mode, recall: (q, cid) => recallOverHttp(q, cid === "unknown" ? undefined : cid) });
    const failureModes = mode === "live" ? await fetchFailureModeBlock(workingDirectory) : "";
    const combined = composeSessionStartOutput(failureModes, out);
    if (combined) process.stdout.write(combined);
  } catch {
    // Fail open — never block or fail a session start.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
