#!/usr/bin/env node
/**
 * Extract (query, surfaced_id, surfaced_body, label, weight, source) triples
 * from the NLM telemetry logs for reranker training data.
 *
 * Data sources:
 *   ~/.nlm/hook-log.jsonl  — one row per UserPromptSubmit/SessionStart fire,
 *                            fields: ts, conversationId, promptPreview, wouldInject[]
 *   ~/.nlm/citation-log.jsonl — one row per detected citation,
 *                            fields: ts, conversation_id, cited_id, kind
 *   ~/.nlm/canonical.sqlite — sessions table for surfaced_body lookup
 *
 * Algorithm:
 *   1. Index citations by (conversationId, citedId, kind).
 *   2. Identify "gold conversations": conversations that produced at least one
 *      tool_use citation. These are the only conversations with confirmed
 *      positive signal — surfaced-but-not-cited sessions in them are genuine
 *      hard negatives.
 *   3. For each hook-log entry with wouldInject.length > 0:
 *      - If the conversation is a gold conversation:
 *        * tool_use cited sessions → weight 1.0, source "tool_use" (gold positive)
 *        * NOT cited sessions → weight 0.0, source "hard_negative"
 *      - Prose-only conversations are skipped (signal too noisy).
 *   4. Fetch surfaced_body from SQLite for each (query, surfaced_id) pair.
 *   5. Write JSONL to --output path (or stdout).
 *
 * Dedup: one triple per (query, surfaced_id, source) key — duplicate hook
 * fires for the same (conversationId, id) pair are collapsed.
 *
 * Usage:
 *   node scripts/extract-triples.mjs                    # stdout, last 30d
 *   node scripts/extract-triples.mjs --days 7           # last 7 days
 *   node scripts/extract-triples.mjs --output triples.jsonl
 *   node scripts/extract-triples.mjs --stats            # summary only, no output
 */

import { createReadStream, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import Database from "better-sqlite3";

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const days = (() => {
  const idx = args.indexOf("--days");
  return idx !== -1 ? Number.parseInt(args[idx + 1], 10) || 30 : 30;
})();
const outputPath = (() => {
  const idx = args.indexOf("--output");
  return idx !== -1 ? args[idx + 1] : null;
})();
const statsOnly = args.includes("--stats");

const hookLogPath = process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
const citationLogPath = process.env["NLM_CITATION_LOG"] ?? join(homedir(), ".nlm", "citation-log.jsonl");
const dbPath = process.env["NLM_DB_PATH"] ?? join(homedir(), ".nlm", "canonical.sqlite");

const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

function tsMs(entry, field = "ts") {
  const v = entry[field];
  if (typeof v !== "string") return 0;
  return Date.parse(v);
}

// ── Step 1: Load citations ────────────────────────────────────────────────────

const citationRows = await readJsonl(citationLogPath);

// Map: conversationId → Set of tool_use cited IDs
const toolUseCitations = new Map();
// Set of gold conversations (those with ≥1 tool_use citation)
const goldConversations = new Set();

for (const row of citationRows) {
  if (row.kind !== "tool_use") continue;
  const convId = row.conversation_id;
  const citedId = row.cited_id;
  if (!convId || !citedId) continue;
  if (!toolUseCitations.has(convId)) toolUseCitations.set(convId, new Set());
  toolUseCitations.get(convId).add(citedId);
  goldConversations.add(convId);
}

// ── Step 2: Load hook-log entries in window ───────────────────────────────────

const hookRows = await readJsonl(hookLogPath);

// Collect: for each (query, surfaced_id), record (conversationId, weight, source)
// Dedup key: `${conversationId}::${query}::${surfaced_id}::${source}`
const seen = new Set();
const rawTriples = [];

for (const row of hookRows) {
  // Skip stop-hook entries
  if (typeof row.kind === "string") continue;
  const ts = tsMs(row);
  if (!ts || ts < cutoff) continue;
  const conversationId = row.conversationId;
  const query = row.promptPreview;
  const wouldInject = Array.isArray(row.wouldInject) ? row.wouldInject : [];
  if (!conversationId || !query || wouldInject.length === 0) continue;
  // Only process gold conversations
  if (!goldConversations.has(conversationId)) continue;

  const cited = toolUseCitations.get(conversationId) ?? new Set();

  for (const surfacedId of wouldInject) {
    if (typeof surfacedId !== "string") continue;
    const isCited = cited.has(surfacedId);
    const source = isCited ? "tool_use" : "hard_negative";
    const weight = isCited ? 1.0 : 0.0;
    const key = `${conversationId}::${query}::${surfacedId}::${source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rawTriples.push({ query, surfaced_id: surfacedId, weight, source });
  }
}

if (rawTriples.length === 0) {
  console.error(
    `extract-triples: no triples found. ` +
    `Checked ${goldConversations.size} gold conversations in the last ${days}d. ` +
    `Ensure tool_use citations exist in citation-log.jsonl (Stop hook + cite_session populate it).`,
  );
  process.exit(0);
}

// ── Step 3: Fetch surfaced_body from SQLite ────────────────────────────────────

const uniqueIds = [...new Set(rawTriples.map((t) => t.surfaced_id))];

let bodyById = new Map();
if (existsSync(dbPath)) {
  try {
    const db = new Database(dbPath, { readonly: true });
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, body FROM sessions WHERE id IN (${placeholders})`,
    ).all(...uniqueIds);
    for (const row of rows) {
      bodyById.set(row.id, typeof row.body === "string" ? row.body : "");
    }
    db.close();
  } catch (err) {
    console.error(`extract-triples: sqlite lookup failed — ${err.message}. Bodies will be empty.`);
  }
} else {
  console.error(`extract-triples: db not found at ${dbPath}. Bodies will be empty.`);
}

// ── Step 4: Assemble final triples ────────────────────────────────────────────

const triples = rawTriples.map((t) => ({
  query: t.query,
  surfaced_id: t.surfaced_id,
  surfaced_body: bodyById.get(t.surfaced_id) ?? "",
  label: t.weight === 1.0 ? "positive" : "negative",
  weight: t.weight,
  source: t.source,
}));

// ── Stats ─────────────────────────────────────────────────────────────────────

const positives = triples.filter((t) => t.weight === 1.0).length;
const negatives = triples.filter((t) => t.weight === 0.0).length;
const withBody = triples.filter((t) => t.surfaced_body.length > 0).length;

console.error(
  `extract-triples: ${triples.length} triples ` +
  `(${positives} positive, ${negatives} hard-negative, ${withBody}/${triples.length} with body) ` +
  `from ${goldConversations.size} gold conversations over last ${days}d`,
);

if (statsOnly) process.exit(0);

// ── Step 5: Write output ──────────────────────────────────────────────────────

const lines = triples.map((t) => JSON.stringify(t)).join("\n") + "\n";

if (outputPath) {
  writeFileSync(outputPath, lines, "utf8");
  console.error(`extract-triples: wrote ${triples.length} rows to ${outputPath}`);
} else {
  process.stdout.write(lines);
}
