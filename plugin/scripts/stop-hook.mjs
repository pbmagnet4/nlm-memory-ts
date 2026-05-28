#!/usr/bin/env node

// src/hook/stop-hook.ts
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync as mkdirSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname, join as join3 } from "node:path";

// src/core/hook/citation-detect.ts
var MIN_ID_LEN = 6;
function detectCitations(input) {
  const surfaced = [];
  const seen = /* @__PURE__ */ new Set();
  for (const id of input.surfacedIds) {
    if (id.length < MIN_ID_LEN) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    surfaced.push(id);
  }
  const cited = [];
  const claimedByToolUse = /* @__PURE__ */ new Set();
  for (const tu of input.toolUses) {
    if (!isNlmTool(tu.name)) continue;
    if (isCiteSessionTool(tu.name)) {
      const explicitId = safeInputId(tu.input);
      if (explicitId && surfaced.includes(explicitId) && !claimedByToolUse.has(explicitId)) {
        cited.push({ id: explicitId, kind: "tool_use" });
        claimedByToolUse.add(explicitId);
      }
      continue;
    }
    const serialized = safeStringify(tu.input);
    if (!serialized) continue;
    for (const id of surfaced) {
      if (claimedByToolUse.has(id)) continue;
      if (serialized.includes(id)) {
        cited.push({ id, kind: "tool_use" });
        claimedByToolUse.add(id);
      }
    }
  }
  if (input.responseText) {
    for (const id of surfaced) {
      if (claimedByToolUse.has(id)) continue;
      if (input.responseText.includes(id)) {
        cited.push({ id, kind: "prose" });
      }
    }
  }
  return cited;
}
function isNlmTool(name) {
  return /^mcp__[^_]*nlm[^_]*__/.test(name);
}
function isCiteSessionTool(name) {
  return name.endsWith("__cite_session");
}
function safeInputId(input) {
  if (typeof input === "object" && input !== null && "id" in input) {
    const id = input["id"];
    if (typeof id === "string") return id;
  }
  return void 0;
}
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

// src/core/hook/memo.ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function stateDir() {
  return process.env["NLM_HOOK_STATE_DIR"] ?? join(homedir(), ".nlm", "hook-state");
}
function memoPath(conversationId) {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return join(stateDir(), `${safe}.json`);
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

// src/core/hook/cite-memo.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
function stateDir2() {
  return process.env["NLM_HOOK_STATE_DIR"] ?? join2(homedir2(), ".nlm", "hook-state");
}
function memoPath2(conversationId) {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return join2(stateDir2(), `${safe}.cited.json`);
}
function loadCited(conversationId) {
  try {
    const path = memoPath2(conversationId);
    if (!existsSync2(path)) return /* @__PURE__ */ new Set();
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    if (!Array.isArray(parsed)) return /* @__PURE__ */ new Set();
    return new Set(parsed.filter((x) => typeof x === "string"));
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function recordCited(conversationId, ids) {
  if (ids.length === 0) return;
  try {
    const merged = loadCited(conversationId);
    for (const id of ids) merged.add(id);
    mkdirSync2(stateDir2(), { recursive: true });
    writeFileSync2(memoPath2(conversationId), JSON.stringify([...merged]), "utf8");
  } catch {
  }
}

// src/core/hook/transcript.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
function parseTurn(parsed) {
  if (parsed.type !== "assistant" || !parsed.message) return null;
  const content = parsed.message.content;
  if (typeof content === "string") {
    return content ? { text: content, toolUses: [] } : null;
  }
  if (!Array.isArray(content)) return null;
  const textParts = [];
  const toolUses = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      toolUses.push({ name: block.name, input: block.input });
    }
  }
  if (textParts.length === 0 && toolUses.length === 0) return null;
  return { text: textParts.join("\n"), toolUses };
}
function readLines(transcriptPath) {
  if (!transcriptPath || !existsSync3(transcriptPath)) return null;
  try {
    return readFileSync3(transcriptPath, "utf8").split("\n");
  } catch {
    return null;
  }
}
function readAllAssistantTurns(transcriptPath) {
  const lines = readLines(transcriptPath);
  if (!lines) return [];
  const turns = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const turn = parseTurn(parsed);
    if (turn) turns.push(turn);
  }
  return turns;
}

// src/hook/stop-hook.ts
var RESPONSE_PREVIEW_CHARS = 200;
var POST_TIMEOUT_MS = 1500;
async function runStopHook(input, deps) {
  if (input.stopHookActive) {
    return {
      conversationId: input.conversationId,
      surfacedCount: 0,
      citations: [],
      responsePreview: "",
      skipped: true
    };
  }
  const surfaced = loadSurfaced(input.conversationId);
  if (surfaced.size === 0) {
    return {
      conversationId: input.conversationId,
      surfacedCount: 0,
      citations: [],
      responsePreview: "",
      skipped: false
    };
  }
  const turns = readAllAssistantTurns(input.transcriptPath);
  if (turns.length === 0) {
    return {
      conversationId: input.conversationId,
      surfacedCount: surfaced.size,
      citations: [],
      responsePreview: "",
      skipped: false
    };
  }
  const allToolUses = [];
  const textParts = [];
  for (const turn of turns) {
    if (turn.text) textParts.push(turn.text);
    for (const tu of turn.toolUses) allToolUses.push(tu);
  }
  const unionText = textParts.join("\n");
  const detected = detectCitations({
    responseText: unionText,
    toolUses: allToolUses,
    surfacedIds: surfaced
  });
  const alreadyCited = loadCited(input.conversationId);
  const fresh = detected.filter((c) => !alreadyCited.has(c.id));
  const lastText = turns[turns.length - 1]?.text ?? "";
  const preview = lastText.slice(0, RESPONSE_PREVIEW_CHARS);
  for (const c of fresh) {
    try {
      await deps.postCitation(input.conversationId, c.id, c.kind, preview);
    } catch {
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
    skipped: false
  };
}
function logPath() {
  return process.env["NLM_HOOK_LOG"] ?? join3(homedir3(), ".nlm", "hook-log.jsonl");
}
function logStopResult(result) {
  try {
    const path = logPath();
    mkdirSync3(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "stop",
        conversationId: result.conversationId,
        surfacedCount: result.surfacedCount,
        citedIds: result.citations.map((c) => c.id),
        citationKinds: result.citations.map((c) => c.kind),
        skipped: result.skipped,
        mode: process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow"
      })}
`,
      "utf8"
    );
  } catch {
  }
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
        response_preview: responsePreview
      }),
      signal: controller.signal
    });
  } finally {
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
    const result = await runStopHook(
      { conversationId, transcriptPath, stopHookActive },
      { postCitation: postCitationOverHttp }
    );
    logStopResult(result);
  } catch {
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
export {
  runStopHook
};
