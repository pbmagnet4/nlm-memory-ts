#!/usr/bin/env node

// src/hook/prompt-recall-hook.ts
import { pathToFileURL } from "node:url";

// src/core/hook/gate.ts
var LEADING_FILLER = /^(please|can you|could you|would you|will you|i need you to|i'd like you to|i want you to|i would like you to|help me|let's|lets|hey|ok|okay)\b[\s,]*/i;
var GENERATIVE_OPENER = /^(write|draft|create|compose|generate|brainstorm|design|outline|sketch|invent|rename|come up with)\b/i;
function classifyPrompt(prompt) {
  let p = prompt.trim();
  for (let i = 0; i < 3 && LEADING_FILLER.test(p); i++) {
    p = p.replace(LEADING_FILLER, "");
  }
  return GENERATIVE_OPENER.test(p) ? "generative" : "evaluate";
}

// src/core/hook/hook-log.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
function logPath() {
  return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}
function appendHookLog(entry) {
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}
`, "utf8");
  } catch {
  }
}

// src/core/hook/memo.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
function stateDir() {
  return process.env["NLM_HOOK_STATE_DIR"] ?? join2(homedir2(), ".nlm", "hook-state");
}
function memoPath(conversationId) {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return join2(stateDir(), `${safe}.json`);
}
function loadSurfaced(conversationId) {
  try {
    const path = memoPath(conversationId);
    if (!existsSync(path)) return /* @__PURE__ */ new Set();
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return /* @__PURE__ */ new Set();
    return new Set(parsed.filter((x) => typeof x === "string"));
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function recordSurfaced(conversationId, ids) {
  try {
    const merged = loadSurfaced(conversationId);
    for (const id of ids) merged.add(id);
    mkdirSync2(stateDir(), { recursive: true });
    writeFileSync(memoPath(conversationId), JSON.stringify([...merged]), "utf8");
  } catch {
  }
}

// src/core/hook/pointer-block.ts
function formatPointerBlock(hits) {
  if (hits.length === 0) return "";
  const lines = hits.map(
    (h) => `- ${h.id} \xB7 ${h.label} (${h.startedAt.slice(0, 10)})`
  );
  return [
    "## Possibly-relevant prior sessions (nlm-memory)",
    ...lines,
    "NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved)."
  ].join("\n");
}

// src/core/hook/select.ts
function selectHits(params) {
  const { hits, surfaced, scoreThreshold, perFireCap, perConversationCap } = params;
  const eligible = hits.filter(
    (h) => h.matchScore >= scoreThreshold && !surfaced.has(h.id)
  );
  const budget = Math.max(0, perConversationCap - surfaced.size);
  const limit = Math.min(perFireCap, budget);
  return eligible.slice(0, limit);
}

// src/hook/prompt-recall-hook.ts
var SCORE_THRESHOLD = 0;
var PER_FIRE_CAP = 3;
var PER_CONVERSATION_CAP = 10;
var RECALL_LIMIT = 5;
var RECALL_TIMEOUT_MS = 2e3;
var PROMPT_PREVIEW_CHARS = 200;
async function runHook(input, deps) {
  const gate = classifyPrompt(input.prompt);
  const preview = input.prompt.slice(0, PROMPT_PREVIEW_CHARS);
  if (gate === "generative") {
    appendHookLog({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      conversationId: input.conversationId,
      promptPreview: preview,
      gate,
      hits: [],
      wouldInject: [],
      estTokens: 0,
      mode: deps.mode
    });
    return "";
  }
  let hits = [];
  try {
    hits = await deps.recall(input.prompt);
  } catch {
    hits = [];
  }
  const surfaced = loadSurfaced(input.conversationId);
  const selected = selectHits({
    hits,
    surfaced,
    scoreThreshold: SCORE_THRESHOLD,
    perFireCap: PER_FIRE_CAP,
    perConversationCap: PER_CONVERSATION_CAP
  });
  const block = formatPointerBlock(selected);
  const estTokens = Math.ceil(block.length / 4);
  appendHookLog({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    conversationId: input.conversationId,
    promptPreview: preview,
    gate,
    hits: hits.map((h) => ({ id: h.id, score: h.matchScore })),
    wouldInject: selected.map((h) => h.id),
    estTokens,
    mode: deps.mode
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
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
async function recallOverHttp(prompt) {
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url = `http://localhost:${portValue}/api/recall?q=${encodeURIComponent(prompt)}&mode=keyword&limit=${RECALL_LIMIT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "x-recall-source": "hook" },
      signal: controller.signal
    });
    if (!res.ok) return [];
    let body;
    try {
      body = await res.json();
    } catch {
      return [];
    }
    return (body.results ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      startedAt: r.startedAt,
      matchScore: r.matchScore
    }));
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const conversationId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
    if (!prompt) return;
    const mode = process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow";
    const out = await runHook(
      { prompt, conversationId },
      { mode, recall: recallOverHttp }
    );
    if (out) process.stdout.write(out);
  } catch {
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
export {
  runHook
};
