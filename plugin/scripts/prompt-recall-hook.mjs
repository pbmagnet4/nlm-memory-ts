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
function formatPointerBlock(hits, facts = []) {
  if (hits.length === 0 && facts.length === 0) return "";
  const out = [];
  if (hits.length > 0) {
    out.push("## Possibly-relevant prior sessions (nlm-memory)");
    for (const h of hits) {
      out.push(`- ${h.id} \xB7 ${h.label} (${h.startedAt.slice(0, 10)})`);
    }
  }
  if (facts.length > 0) {
    if (out.length > 0) out.push("");
    out.push("## Known facts about top entities");
    for (const f of facts) {
      const tag = f.corroborationCount > 1 ? ` [${f.corroborationCount} sessions]` : "";
      out.push(`- ${f.subject} ${f.predicate}: ${f.value}${tag}`);
    }
  }
  out.push(
    "NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved)."
  );
  return out.join("\n");
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

// src/llm/env-autoload.ts
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { resolve } from "node:path";
var DEFAULT_SEARCH_PATHS = [
  "~/.nlm/.env",
  "./.env",
  "../.env",
  "../../.env"
];
function expandHome(p) {
  if (p.startsWith("~/")) return resolve(homedir3(), p.slice(2));
  return p;
}
function autoloadEnv(extraPaths = []) {
  const loaded = [];
  const paths = [...DEFAULT_SEARCH_PATHS, ...extraPaths];
  for (const raw of paths) {
    const path = expandHome(raw);
    if (!existsSync2(path)) continue;
    try {
      const content = readFileSync2(path, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const eq = trimmed.indexOf("=");
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        if (key && process.env[key] === void 0) {
          process.env[key] = value;
        }
      }
      loaded.push(path);
    } catch {
      continue;
    }
  }
  return loaded;
}

// src/hook/hook-auth.ts
function hookAuthHeaders(extra = {}) {
  const token = process.env["NLM_MCP_TOKEN"];
  if (!token) return { ...extra };
  return { ...extra, authorization: `Bearer ${token}` };
}

// src/core/hook/query-extract.ts
var STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "dare",
  "ought",
  "yes",
  "no",
  "not",
  "please",
  "thank",
  "thanks",
  "ok",
  "okay",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "and",
  "or",
  "but",
  "if",
  "so",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "from",
  "with",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "just",
  "now",
  "also",
  "get",
  "let",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "any",
  "much",
  "many",
  "sounds",
  "good",
  "great",
  "sure",
  "right",
  "well",
  "done",
  "nice",
  "cool",
  "perfect",
  "exactly",
  "proceed",
  "continue",
  "go",
  "ahead",
  "next",
  "help"
]);
var MIN_CONTENT_WORDS = 2;
var MIN_WORD_LEN = 3;
function extractRecallQuery(prompt) {
  const tokens = prompt.trim().split(/\s+/).map((t) => t.replace(/^[^\w-]+|[^\w-]+$/g, "")).filter((t) => t.length >= MIN_WORD_LEN);
  const contentWords = tokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  if (contentWords.length < MIN_CONTENT_WORDS) return null;
  return contentWords.join(" ");
}

// src/hook/recall-over-http.ts
var RECALL_LIMIT = 5;
var RECALL_TIMEOUT_MS = 2e3;
async function recallOverHttp(prompt, runtime) {
  const query = extractRecallQuery(prompt);
  if (query === null) return { hits: [], facts: [] };
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url = `http://localhost:${portValue}/api/recall?q=${encodeURIComponent(query)}&mode=keyword&limit=${RECALL_LIMIT}&withFacts=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  try {
    const extra = { "x-recall-source": "hook" };
    if (runtime) extra["x-recall-runtime"] = runtime;
    const res = await fetch(url, {
      headers: hookAuthHeaders(extra),
      signal: controller.signal
    });
    if (!res.ok) return { hits: [], facts: [] };
    let body;
    try {
      body = await res.json();
    } catch {
      return { hits: [], facts: [] };
    }
    const hits = (body.results ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      startedAt: r.startedAt,
      matchScore: r.matchScore
    }));
    const facts = (body.relatedFacts ?? []).map((f) => ({
      subject: f.subject,
      predicate: f.predicate,
      value: f.value,
      corroborationCount: f.corroborationCount
    }));
    return { hits, facts };
  } finally {
    clearTimeout(timer);
  }
}

// src/hook/prompt-recall-hook.ts
var SCORE_THRESHOLD = 0;
var PER_FIRE_CAP = 3;
var PER_CONVERSATION_CAP = 10;
var PROMPT_PREVIEW_CHARS = 200;
function normalizeRecall(raw) {
  if (Array.isArray(raw)) return { hits: raw, facts: [] };
  return raw;
}
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
  let fetched = { hits: [], facts: [] };
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
    perConversationCap: PER_CONVERSATION_CAP
  });
  const block = formatPointerBlock(selected, fetched.facts);
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
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve2(data));
    process.stdin.on("error", () => resolve2(data));
  });
}
async function main() {
  try {
    autoloadEnv();
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const conversationId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
    if (!prompt) return;
    const mode = process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow";
    const out = await runHook(
      { prompt, conversationId },
      { mode, recall: (q) => recallOverHttp(q, "claude-code") }
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
