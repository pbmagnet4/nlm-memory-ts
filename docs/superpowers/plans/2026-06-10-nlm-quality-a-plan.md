# NLM Quality: B+ → A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three root causes keeping nlm-memory below an A: garbage recall on short/conversational prompts, no real-world precision measurement, and a signal loop that never closes because agents don't explicitly cite sessions.

**Architecture:** Phase 1 adds a content-word extractor that filters the FTS5 query before it fires — this alone fixes the "yes please → Cronic sessions" failure. Phase 2 adds a `nlm precision` CLI that joins query_log.jsonl with citation_log.jsonl to give a real-world number to track. Phase 3 adds a `nlm cite-on-use` behavior rule (installed via the existing hook infrastructure) that makes the Claude Code agent automatically call `cite_session` when it reads a surfaced session ID — this is what makes the citation log accumulate real signal. Phase 4 builds a simple citation-frequency reranker on top of the accumulated data.

**Tech Stack:** TypeScript (strict), Vitest, Commander 15, SQLite FTS5, Node 22. Existing patterns: pure modules with no side effects, I/O only at the port layer, tests next to their unit.

**Root cause confirmed from query_log.jsonl:**
- `"yes please"` → FTS5 query `"yes please"` → surfaced Cronic sessions (wrong)
- `"can you make a plan on getting us towards an A?"` → FTS5 on full text → surfaced random sessions (wrong)
- `"Resume the nlm-memory Wave 2 dependency upgrade (NocoDB task #283)..."` → 30+ content words → recall works well
- The `classifyPrompt` gate only skips explicit creation verbs (write/draft/create). It lets conversational short messages through.

---

## Phase 1: Fix Query Formation

### Task 1: Content-word extractor

**Files:**
- Create: `src/core/hook/query-extract.ts`
- Create: `tests/unit/core/hook/query-extract.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/core/hook/query-extract.test.ts
import { describe, expect, it } from "vitest";
import { extractRecallQuery } from "../../../../src/core/hook/query-extract.js";

describe("extractRecallQuery", () => {
  it("returns null for pure conversational messages", () => {
    expect(extractRecallQuery("yes please")).toBeNull();
    expect(extractRecallQuery("ok")).toBeNull();
    expect(extractRecallQuery("sounds good")).toBeNull();
    expect(extractRecallQuery("yes")).toBeNull();
    expect(extractRecallQuery("   ")).toBeNull();
  });

  it("returns null when fewer than 2 content words remain after stopword removal", () => {
    expect(extractRecallQuery("can you")).toBeNull();
    expect(extractRecallQuery("what is the")).toBeNull();
  });

  it("extracts content words from a technical message", () => {
    const q = extractRecallQuery("can you make a plan on getting us towards an A?");
    expect(q).not.toBeNull();
    // "make", "plan", "getting", "towards" survive stopword filter
    expect(q).toContain("plan");
  });

  it("preserves proper nouns and project names", () => {
    const q = extractRecallQuery("Resume the nlm-memory Wave 2 dependency upgrade");
    expect(q).not.toBeNull();
    expect(q).toContain("nlm-memory");
    expect(q).toContain("dependency");
    expect(q).toContain("upgrade");
  });

  it("removes stopwords but keeps substantive words", () => {
    const q = extractRecallQuery("what did we decide about pgvector vs Qdrant");
    expect(q).not.toBeNull();
    expect(q).toContain("decide");
    expect(q).toContain("pgvector");
    expect(q).toContain("qdrant");
    expect(q).not.toContain("what");
    expect(q).not.toContain("did");
    expect(q).not.toContain("about");
  });

  it("normalizes case on stopword check but preserves case in output", () => {
    const q = extractRecallQuery("React 19 migration breaking changes");
    expect(q).not.toBeNull();
    // Stopwords are case-insensitive matched but output preserves original case
    expect(q).toContain("React");
    expect(q).toContain("migration");
    expect(q).toContain("breaking");
    expect(q).toContain("changes");
  });

  it("handles hyphenated tokens as single words", () => {
    const q = extractRecallQuery("better-sqlite3 native rebuild node22");
    expect(q).not.toBeNull();
    expect(q).toContain("better-sqlite3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/echalupa/Documents/Coding\ Projects/nlm-memory
npx vitest run tests/unit/core/hook/query-extract.test.ts
```
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `query-extract.ts`**

```typescript
// src/core/hook/query-extract.ts

/**
 * Content-word extractor for FTS5 recall queries.
 *
 * The hook receives raw prompt text from the UserPromptSubmit event.
 * Short/conversational messages ("yes please", "ok", "sounds good") produce
 * garbage FTS5 results because the tokenizer matches them against noise.
 *
 * This module filters out stopwords and returns null when the remaining
 * content words are too few to produce a useful query. The null signal
 * tells recall-over-http to skip the round-trip entirely.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "yes", "no", "not", "please", "thank", "thanks", "ok", "okay",
  "i", "me", "my", "we", "us", "our", "you", "your", "it", "its",
  "this", "that", "these", "those", "and", "or", "but", "if", "so",
  "to", "of", "in", "on", "at", "by", "for", "from", "with", "about",
  "into", "through", "during", "before", "after", "above", "below",
  "up", "down", "out", "off", "over", "under", "again", "further",
  "then", "once", "here", "there", "when", "where", "why", "how",
  "all", "both", "each", "few", "more", "most", "other", "some", "such",
  "than", "too", "very", "just", "now", "also", "get", "let", "make",
  "what", "which", "who", "whom", "whose", "any", "much", "many",
  "going", "getting", "towards", "sounds", "good", "great", "sure",
  "right", "well", "done", "nice", "cool", "perfect", "exactly",
  "proceed", "continue", "go", "ahead", "next", "help",
]);

const MIN_CONTENT_WORDS = 2;
const MIN_WORD_LEN = 3;

/**
 * Extract content words from a prompt for use as an FTS5 recall query.
 * Returns null when the message is too conversational to produce a useful
 * query — the caller should skip recall entirely in that case.
 */
export function extractRecallQuery(prompt: string): string | null {
  // Tokenize: split on whitespace, keep hyphenated compounds intact.
  // Strip leading/trailing punctuation from each token but preserve
  // hyphens within tokens (e.g. "better-sqlite3", "nlm-memory").
  const tokens = prompt
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\w-]+|[^\w-]+$/g, ""))
    .filter((t) => t.length >= MIN_WORD_LEN);

  const contentWords = tokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));

  if (contentWords.length < MIN_CONTENT_WORDS) return null;
  return contentWords.join(" ");
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/core/hook/query-extract.test.ts
```
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/hook/query-extract.ts tests/unit/core/hook/query-extract.test.ts
git commit -m "feat(hook): add content-word extractor for FTS5 recall queries"
```

---

### Task 2: Wire extractor into recall-over-http

**Files:**
- Modify: `src/hook/recall-over-http.ts`

The extractor replaces the raw `prompt` in the query URL. A `null` result means skip the HTTP call entirely.

- [ ] **Step 1: Write the failing test** (integration — verify null prompt skips HTTP)

There is no existing test for `recall-over-http.ts`. Add one now:

```typescript
// tests/unit/hook/recall-over-http.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// We test at the extractRecallQuery boundary — the HTTP call itself is not
// mocked here because that requires a running server. Instead, verify that
// the exported helper returns the right shape and that short prompts return
// the empty result without network activity.

import { extractRecallQuery } from "../../../src/core/hook/query-extract.js";

describe("recall-over-http query filtering", () => {
  it("extractRecallQuery returns null for short conversational prompts", () => {
    expect(extractRecallQuery("yes please")).toBeNull();
    expect(extractRecallQuery("ok")).toBeNull();
    expect(extractRecallQuery("proceed")).toBeNull();
  });

  it("extractRecallQuery returns a non-empty string for technical prompts", () => {
    const q = extractRecallQuery("nlm-memory dependency upgrade Wave 2");
    expect(typeof q).toBe("string");
    expect((q as string).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (no change needed — testing the extractor is the boundary)

```bash
npx vitest run tests/unit/hook/recall-over-http.test.ts
```
Expected: PASS (tests the already-implemented extractor)

- [ ] **Step 3: Modify `recall-over-http.ts`**

Add the import at the top and wrap the URL construction:

```typescript
// src/hook/recall-over-http.ts
// Add import after existing imports:
import { extractRecallQuery } from "@core/hook/query-extract.js";

// In recallOverHttp(), replace the start of the function body:
export async function recallOverHttp(
  prompt: string,
  runtime?: string,
): Promise<RecallOverHttpResult> {
  const query = extractRecallQuery(prompt);
  if (query === null) return { hits: [], facts: [] };

  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url =
    `http://localhost:${portValue}/api/recall` +
    `?q=${encodeURIComponent(query)}&mode=keyword&limit=${RECALL_LIMIT}&withFacts=true`;
  // ... rest of function unchanged
```

- [ ] **Step 4: Run full test suite**

```bash
npm test
```
Expected: 877+ tests pass (same baseline; the new test adds 2 more)

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 6: Rebuild and verify hook artifacts update**

```bash
npm run build
```
Expected: `plugin/scripts/prompt-recall-hook.mjs` and `nlm/index.js` rebuilt.

Check the rebuilt artifact includes `extractRecallQuery`:
```bash
grep -c "extractRecallQuery\|contentWords\|STOPWORDS" plugin/scripts/prompt-recall-hook.mjs
```
Expected: >= 3 (the function is bundled in)

- [ ] **Step 7: Commit**

```bash
git add src/hook/recall-over-http.ts tests/unit/hook/recall-over-http.test.ts \
        plugin/scripts/prompt-recall-hook.mjs nlm/index.js plugin/scripts/stop-hook.mjs
git commit -m "feat(hook): filter short/conversational prompts before FTS5 recall

Short prompts (< 2 content words after stopword removal) now return empty
recall instead of firing FTS5 on noise tokens. 'yes please' no longer
surfaces unrelated sessions. Longer substantive prompts pass content-word
extracted text to FTS5 instead of raw prompt, improving match quality.

Closes the root cause identified in query_log.jsonl audit (2026-06-10):
  'yes please' → Cronic sessions (wrong)
  'can you make a plan...' → random sessions (wrong)
  Both now return empty recall correctly."
```

---

## Phase 2: Real-World Precision Measurement

### Task 3: Precision calculation module

**Files:**
- Create: `src/core/recall/precision.ts`
- Create: `tests/unit/core/recall/precision.test.ts`

The `query_log.jsonl` records `{ conversationId, returnedIds[] }` per recall call.
The `citation_log.jsonl` records `{ conversationId, citedId }` per explicit citation.
Precision@k = sessions_cited / sessions_surfaced, per conversation, then averaged.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/core/recall/precision.test.ts
import { describe, expect, it } from "vitest";
import { computePrecision, type PrecisionResult } from "../../../../src/core/recall/precision.js";
import type { LogEntry } from "../../../../src/core/recall/query-log.js";
import type { CitationEntry } from "../../../../src/core/recall/citation-log.js";

const makeQueryEntry = (conversationId: string, returnedIds: string[]): LogEntry => ({
  source: "hook",
  runtime: "claude-code",
  query: "test query",
  entity: null,
  kind: null,
  mode: "keyword",
  limit: 5,
  nResults: returnedIds.length,
  returnedIds,
});

const makeCitationEntry = (conversationId: string, citedId: string): CitationEntry => ({
  conversationId,
  citedId,
  kind: "tool_use",
});

describe("computePrecision", () => {
  it("returns zero precision when no citations match surfaced sessions", () => {
    const queries: Array<{ conversationId: string; entry: LogEntry }> = [
      { conversationId: "conv_a", entry: makeQueryEntry("conv_a", ["sess_1", "sess_2"]) },
    ];
    const citations: CitationEntry[] = [
      makeCitationEntry("conv_a", "sess_9"),  // cited something not surfaced
    ];
    const result = computePrecision(queries, citations);
    expect(result.precisionAtK).toBe(0);
    expect(result.conversationCount).toBe(1);
  });

  it("returns 1.0 when every surfaced session is cited", () => {
    const queries: Array<{ conversationId: string; entry: LogEntry }> = [
      { conversationId: "conv_a", entry: makeQueryEntry("conv_a", ["sess_1", "sess_2"]) },
    ];
    const citations: CitationEntry[] = [
      makeCitationEntry("conv_a", "sess_1"),
      makeCitationEntry("conv_a", "sess_2"),
    ];
    const result = computePrecision(queries, citations);
    expect(result.precisionAtK).toBe(1.0);
  });

  it("computes partial precision correctly", () => {
    const queries: Array<{ conversationId: string; entry: LogEntry }> = [
      { conversationId: "conv_a", entry: makeQueryEntry("conv_a", ["sess_1", "sess_2", "sess_3", "sess_4"]) },
    ];
    const citations: CitationEntry[] = [
      makeCitationEntry("conv_a", "sess_1"),
      makeCitationEntry("conv_a", "sess_2"),
    ];
    const result = computePrecision(queries, citations);
    expect(result.precisionAtK).toBeCloseTo(0.5, 5);
  });

  it("averages precision across multiple conversations", () => {
    const queries: Array<{ conversationId: string; entry: LogEntry }> = [
      { conversationId: "conv_a", entry: makeQueryEntry("conv_a", ["sess_1", "sess_2"]) },
      { conversationId: "conv_b", entry: makeQueryEntry("conv_b", ["sess_3", "sess_4"]) },
    ];
    const citations: CitationEntry[] = [
      makeCitationEntry("conv_a", "sess_1"),  // 1/2 = 0.5
      makeCitationEntry("conv_b", "sess_3"),  // 1/2 = 0.5
      makeCitationEntry("conv_b", "sess_4"),  // (already counted)
    ];
    const result = computePrecision(queries, citations);
    // conv_a: 1/2=0.5, conv_b: 2/2=1.0 → avg = 0.75
    expect(result.precisionAtK).toBeCloseTo(0.75, 5);
    expect(result.conversationCount).toBe(2);
  });

  it("skips conversations with no surfaced sessions (hook fired but returned empty)", () => {
    const queries: Array<{ conversationId: string; entry: LogEntry }> = [
      { conversationId: "conv_a", entry: makeQueryEntry("conv_a", []) },
      { conversationId: "conv_b", entry: makeQueryEntry("conv_b", ["sess_1"]) },
    ];
    const citations: CitationEntry[] = [
      makeCitationEntry("conv_b", "sess_1"),
    ];
    const result = computePrecision(queries, citations);
    expect(result.conversationCount).toBe(1);  // conv_a skipped
    expect(result.precisionAtK).toBe(1.0);
  });

  it("returns null precision when there are no scoreable conversations", () => {
    const result = computePrecision([], []);
    expect(result.precisionAtK).toBeNull();
    expect(result.conversationCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/core/recall/precision.test.ts
```
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `precision.ts`**

```typescript
// src/core/recall/precision.ts

/**
 * Real-world recall precision calculator.
 *
 * Joins query_log.jsonl (what was surfaced) with citation_log.jsonl (what
 * was actually cited) to produce precision@k: the fraction of surfaced
 * sessions that were later cited in the same conversation.
 *
 * This is the ground-truth quality signal for the recall system. A session
 * surfaced but never cited is noise; a session cited is signal.
 */

import type { LogEntry } from "./query-log.js";
import type { CitationEntry } from "./citation-log.js";

export interface PrecisionResult {
  /** Average precision@k across all scored conversations. Null when no data. */
  readonly precisionAtK: number | null;
  /** Number of conversations included in the average. */
  readonly conversationCount: number;
  /** Conversations broken down individually, sorted by precision ascending. */
  readonly perConversation: ReadonlyArray<{
    readonly conversationId: string;
    readonly surfaced: number;
    readonly cited: number;
    readonly precision: number;
  }>;
}

export function computePrecision(
  queries: ReadonlyArray<{ conversationId: string; entry: LogEntry }>,
  citations: ReadonlyArray<CitationEntry>,
): PrecisionResult {
  // Build citation index: conversationId → Set<citedId>
  const citedByConv = new Map<string, Set<string>>();
  for (const c of citations) {
    let s = citedByConv.get(c.conversationId);
    if (!s) {
      s = new Set();
      citedByConv.set(c.conversationId, s);
    }
    s.add(c.citedId);
  }

  // Build surfaced index: conversationId → Set<returnedId>
  const surfacedByConv = new Map<string, Set<string>>();
  for (const { conversationId, entry } of queries) {
    let s = surfacedByConv.get(conversationId);
    if (!s) {
      s = new Set();
      surfacedByConv.set(conversationId, s);
    }
    for (const id of entry.returnedIds) s.add(id);
  }

  const perConversation: Array<{
    conversationId: string;
    surfaced: number;
    cited: number;
    precision: number;
  }> = [];

  for (const [convId, surfaced] of surfacedByConv) {
    if (surfaced.size === 0) continue;  // nothing to score
    const cited = citedByConv.get(convId) ?? new Set<string>();
    const hits = [...surfaced].filter((id) => cited.has(id)).length;
    perConversation.push({
      conversationId: convId,
      surfaced: surfaced.size,
      cited: hits,
      precision: hits / surfaced.size,
    });
  }

  if (perConversation.length === 0) {
    return { precisionAtK: null, conversationCount: 0, perConversation: [] };
  }

  const avg =
    perConversation.reduce((sum, r) => sum + r.precision, 0) /
    perConversation.length;

  perConversation.sort((a, b) => a.precision - b.precision);

  return {
    precisionAtK: avg,
    conversationCount: perConversation.length,
    perConversation,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/core/recall/precision.test.ts
```
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/recall/precision.ts tests/unit/core/recall/precision.test.ts
git commit -m "feat(recall): add precision@k calculator (query_log × citation_log join)"
```

---

### Task 4: `nlm precision` CLI command

**Files:**
- Modify: `src/cli/nlm.ts`

Add a `precision` sub-command that reads both log files, joins them, prints a summary.

- [ ] **Step 1: Locate the insertion point in `nlm.ts`**

The `misses` command is around line 393. Insert the `precision` command after it. The pattern is:
```typescript
program
  .command("precision")
  .description("...")
  .option(...)
  .action(async (opts) => { ... });
```

- [ ] **Step 2: Add the `precision` command**

Add these imports at the top of `src/cli/nlm.ts` with the other recall imports:
```typescript
import { computePrecision } from "../core/recall/precision.js";
import { readQueryLog } from "../core/recall/query-log.js";
import { readCitationLog } from "../core/recall/citation-log.js";
```

> **Note:** `readQueryLog` and `readCitationLog` may not exist yet as exported functions. Check `query-log.ts` and `citation-log.ts`. If the read function doesn't exist, add it in those files first (see note below).

Add the command after the `misses` command:

```typescript
program
  .command("precision")
  .description(
    "Compute real-world recall precision: fraction of surfaced sessions that were later cited.",
  )
  .option("--days <n>", "lookback window in days", (v) => Number.parseInt(v, 10), 30)
  .option("--json", "emit JSON instead of human-readable output")
  .option("--verbose", "show per-conversation breakdown")
  .action(async (opts: { days: number; json: boolean; verbose: boolean }) => {
    const [queryEntries, citationEntries] = await Promise.all([
      readQueryLog(opts.days).catch(() => []),
      readCitationLog(opts.days).catch(() => []),
    ]);

    const result = computePrecision(queryEntries, citationEntries);

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (result.precisionAtK === null) {
      console.log("No scoreable conversations in the last " + opts.days + " day(s).");
      console.log(
        "  Precision requires both recall queries (query_log.jsonl) and explicit citations",
      );
      console.log(
        "  (citation_log.jsonl). If citations are empty, run: nlm help close-loop",
      );
      return;
    }

    const pct = (result.precisionAtK * 100).toFixed(1);
    console.log(`Recall precision@k — last ${opts.days} day(s)`);
    console.log(`  Precision: ${pct}%  (${result.conversationCount} conversations scored)`);

    if (opts.verbose && result.perConversation.length > 0) {
      console.log("\nPer-conversation breakdown (worst first):");
      for (const row of result.perConversation) {
        const p = (row.precision * 100).toFixed(0).padStart(3);
        console.log(`  ${p}%  surfaced=${row.surfaced}  cited=${row.cited}  ${row.conversationId}`);
      }
    }
  });
```

- [ ] **Step 3: Add `readQueryLog` and `readCitationLog` if they don't exist**

Check if `query-log.ts` exports a function to read the log file:
```bash
grep -n "^export" src/core/recall/query-log.ts
grep -n "^export" src/core/recall/citation-log.ts
```

If `readQueryLog` doesn't exist, add to `src/core/recall/query-log.ts`:
```typescript
/** Read query log entries from the last `days` days. Never raises. */
export async function readQueryLog(
  days: number,
): Promise<Array<{ conversationId: string; entry: LogEntry }>> {
  const path = queryLogPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const results: Array<{ conversationId: string; entry: LogEntry }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj["ts"] === "string" && new Date(obj["ts"]).getTime() < cutoff) continue;
      const convId = typeof obj["conversation_id"] === "string" ? obj["conversation_id"] : "unknown";
      const entry: LogEntry = {
        source: String(obj["source"] ?? ""),
        runtime: typeof obj["runtime"] === "string" ? obj["runtime"] : null,
        query: typeof obj["query"] === "string" ? obj["query"] : null,
        entity: typeof obj["entity"] === "string" ? obj["entity"] : null,
        kind: null,
        mode: (obj["mode"] as LogEntry["mode"]) ?? "keyword",
        limit: Number(obj["limit"] ?? 5),
        nResults: Number(obj["n_results"] ?? 0),
        returnedIds: Array.isArray(obj["returned_ids"])
          ? (obj["returned_ids"] as string[])
          : [],
      };
      results.push({ conversationId: convId, entry });
    } catch {
      continue;
    }
  }
  return results;
}
```

If `readCitationLog` doesn't exist, add to `src/core/recall/citation-log.ts`:
```typescript
/** Read citation log entries from the last `days` days. Never raises. */
export async function readCitationLog(days: number): Promise<CitationEntry[]> {
  const path = citationLogPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const results: CitationEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj["ts"] === "string" && new Date(obj["ts"]).getTime() < cutoff) continue;
      if (typeof obj["conversation_id"] !== "string" || typeof obj["cited_id"] !== "string") continue;
      results.push({
        conversationId: obj["conversation_id"],
        citedId: obj["cited_id"],
        kind: obj["kind"] === "tool_use" || obj["kind"] === "prose" ? obj["kind"] : undefined,
        responsePreview: typeof obj["response_preview"] === "string" ? obj["response_preview"] : undefined,
      });
    } catch {
      continue;
    }
  }
  return results;
}
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors. Fix any type errors before continuing.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```
Expected: 879+ pass

- [ ] **Step 6: Manually verify the command**

```bash
npm run build:server
node dist/cli/nlm.js precision --days 90 --verbose
```
Expected: Either shows precision data or the "no scoreable conversations" message with help text.

- [ ] **Step 7: Commit**

```bash
git add src/cli/nlm.ts src/core/recall/query-log.ts src/core/recall/citation-log.ts \
        src/core/recall/precision.ts
git commit -m "feat(cli): add 'nlm precision' command — real-world recall quality metric"
```

---

## Phase 3: Close the Signal Loop

### Task 5: Agent citation behavior rule

This task is not a code change. It updates the Claude Code agent behavior rules so Claude automatically calls `cite_session` when it reads a surfaced session ID in the pointer block — which is what makes `citation_log.jsonl` accumulate real signal.

**The problem:** `miss-log.jsonl` doesn't exist and `citation_log.jsonl` has only test data because agents (including Claude) read the pointer block but never call `cite_session` or `get_session`. The signal loop requires explicit tool use. Without it, Phase 2's precision metric will always show "no scoreable conversations."

**Files:**
- Modify: `/Users/echalupa/Documents/Coding Projects/Whtnxt Agent/.claude/rules/workflows.md`

OR (preferred — keeps the rule with the tool it serves):
- Modify: `plugin/README.md` (add an operator guidance section)
- Create: `.claude/rules/nlm-citation.md` in the Whtnxt Agent workspace

- [ ] **Step 1: Add citation behavior rule to Whtnxt Agent's rules**

Add to `/Users/echalupa/Documents/Coding Projects/Whtnxt Agent/.claude/rules/workflows.md` in the Memory Recall section:

```markdown
## NLM Citation Behavior (always-on)

When the PromptSubmit hook surfaces a session in the pointer block that is actually used as context for the response, call `mcp__nlm-memory__cite_session` with that session ID before responding. This feeds `citation_log.jsonl` which drives the recall precision metric and the future reranker.

A session is "used" when:
- It changes the answer (you wouldn't have said the same thing without it)
- It's referenced explicitly ("as decided in that session...")
- You call `get_session` to read the full transcript

Do NOT cite sessions you merely scanned and found irrelevant.
```

- [ ] **Step 2: Verify the NLM MCP tool is available**

Check that `cite_session` is in the available tools:
```bash
grep -r "cite_session\|nlm-memory" /Users/echalupa/Documents/Coding\ Projects/Whtnxt\ Agent/.mcp.json.example 2>/dev/null | head -5
```

- [ ] **Step 3: Commit the rules change**

```bash
cd "/Users/echalupa/Documents/Coding Projects/Whtnxt Agent"
git add .claude/rules/workflows.md
git commit -m "feat(nlm): add citation behavior rule to close recall signal loop

Agents should call cite_session when a surfaced NLM session actually
influences the response. This makes citation_log.jsonl accumulate real
signal, enabling the precision metric and future reranker."
```

---

## Phase 4: Citation-Frequency Reranker

> **Prerequisite:** Run Phase 3 for at least 2-4 weeks to accumulate real citation data. Check `nlm precision --days 30` — once `conversationCount >= 20`, the reranker has enough signal to be useful.

### Task 6: Citation-frequency score boost

**Files:**
- Create: `src/core/recall/reranker.ts`
- Create: `tests/unit/core/recall/reranker.test.ts`
- Modify: `src/core/recall/recall-service.ts` (apply boost after FTS5 ranking)

The reranker loads the citation log, counts how often each session ID has been cited historically, and adds a small log-scaled boost to that session's FTS5 score. No ML required — frequency is enough for a first pass.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/core/recall/reranker.test.ts
import { describe, expect, it } from "vitest";
import { buildCitationBoosts, applyBoosts, type CitationBoostMap } from "../../../../src/core/recall/reranker.js";
import type { CitationEntry } from "../../../../src/core/recall/citation-log.js";

describe("buildCitationBoosts", () => {
  it("returns an empty map when no citations", () => {
    const boosts = buildCitationBoosts([]);
    expect(boosts.size).toBe(0);
  });

  it("counts citation frequency per session ID", () => {
    const citations: CitationEntry[] = [
      { conversationId: "c1", citedId: "sess_a" },
      { conversationId: "c2", citedId: "sess_a" },
      { conversationId: "c3", citedId: "sess_b" },
    ];
    const boosts = buildCitationBoosts(citations);
    expect(boosts.get("sess_a")).toBeGreaterThan(boosts.get("sess_b")!);
  });
});

describe("applyBoosts", () => {
  it("returns original results unchanged when no boosts apply", () => {
    const results = [
      { id: "sess_x", matchScore: 1.0 },
      { id: "sess_y", matchScore: 0.5 },
    ];
    const boosts: CitationBoostMap = new Map();
    const boosted = applyBoosts(results, boosts);
    expect(boosted[0]!.id).toBe("sess_x");
    expect(boosted[1]!.id).toBe("sess_y");
  });

  it("boosts a frequently-cited session above a higher FTS5 scorer", () => {
    const citations: CitationEntry[] = Array.from({ length: 10 }, (_, i) => ({
      conversationId: `c${i}`,
      citedId: "sess_frequent",
    }));
    const boosts = buildCitationBoosts(citations);
    const results = [
      { id: "sess_new", matchScore: 1.0 },
      { id: "sess_frequent", matchScore: 0.3 },
    ];
    const boosted = applyBoosts(results, boosts);
    expect(boosted[0]!.id).toBe("sess_frequent");
  });

  it("does not allow a boost to flip a zero-score result above non-zero", () => {
    const citations: CitationEntry[] = [
      { conversationId: "c1", citedId: "sess_a" },
    ];
    const boosts = buildCitationBoosts(citations);
    const results = [
      { id: "sess_new", matchScore: 0.5 },
      { id: "sess_a", matchScore: 0 },
    ];
    const boosted = applyBoosts(results, boosts);
    // Zero-score results should not outrank non-zero FTS5 hits
    expect(boosted[0]!.id).toBe("sess_new");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/core/recall/reranker.test.ts
```
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `reranker.ts`**

```typescript
// src/core/recall/reranker.ts

/**
 * Citation-frequency reranker.
 *
 * Sessions that have been explicitly cited in past conversations get a
 * log-scaled score boost. This is a simple learned signal that improves
 * recall for frequently-useful sessions without any ML infrastructure.
 *
 * Boost formula: boostedScore = fts5Score + alpha * log(1 + citationCount)
 * where alpha = 0.15. Zero-score FTS5 results are never promoted above
 * non-zero results (the boost is only applied when fts5Score > 0).
 *
 * Requires citation_log.jsonl to have accumulated real signal (Phase 3).
 */

import type { CitationEntry } from "./citation-log.js";

export type CitationBoostMap = Map<string, number>;

const ALPHA = 0.15;

/**
 * Build a map of session ID → score boost from historical citation data.
 * Boost = ALPHA * Math.log(1 + count). More citations = higher boost,
 * but diminishing returns prevent a single over-cited session from dominating.
 */
export function buildCitationBoosts(
  citations: ReadonlyArray<CitationEntry>,
): CitationBoostMap {
  const counts = new Map<string, number>();
  for (const c of citations) {
    counts.set(c.citedId, (counts.get(c.citedId) ?? 0) + 1);
  }
  const boosts: CitationBoostMap = new Map();
  for (const [id, count] of counts) {
    boosts.set(id, ALPHA * Math.log(1 + count));
  }
  return boosts;
}

/**
 * Apply citation boosts to a ranked result list and re-sort.
 * Zero-score FTS5 results are never promoted above non-zero results.
 */
export function applyBoosts(
  results: ReadonlyArray<{ id: string; matchScore: number }>,
  boosts: CitationBoostMap,
): Array<{ id: string; matchScore: number }> {
  if (boosts.size === 0) return [...results];

  const boosted = results.map((r) => {
    if (r.matchScore === 0) return r;  // don't promote zero-score results
    const boost = boosts.get(r.id) ?? 0;
    return { ...r, matchScore: r.matchScore + boost };
  });

  return boosted.sort((a, b) => b.matchScore - a.matchScore);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/core/recall/reranker.test.ts
```
Expected: all tests PASS

- [ ] **Step 5: Wire into recall-service.ts**

Find the point in `src/core/recall/recall-service.ts` where FTS5 results are returned and add the boost step. Locate the return statement after FTS5 search (around the `keywordSearch` call), then:

```typescript
// In recall-service.ts, add imports:
import { buildCitationBoosts, applyBoosts } from "./reranker.js";
import { readCitationLog } from "./citation-log.js";

// After FTS5 results are gathered, before returning:
const citations = await readCitationLog(90).catch(() => []);
const boosts = buildCitationBoosts(citations);
const rerankedResults = applyBoosts(rawResults, boosts);
// return rerankedResults instead of rawResults
```

> **Note:** Consult the recall-service.ts implementation to find the exact insertion point. The keyword search path and semantic search path should both go through the boost step before returning.

- [ ] **Step 6: Run full test suite and typecheck**

```bash
npm run typecheck && npm test
```
Expected: all tests pass, no type errors

- [ ] **Step 7: Commit**

```bash
git add src/core/recall/reranker.ts tests/unit/core/recall/reranker.test.ts \
        src/core/recall/recall-service.ts
git commit -m "feat(recall): citation-frequency reranker — log-scaled boost from citation_log

Sessions cited frequently in past conversations receive a small score
boost (ALPHA=0.15 * log(1 + count)) on top of FTS5/semantic scores.
Zero-score results are not promoted above non-zero FTS5 hits.

Requires Phase 3 citation data to accumulate before this has effect.
Run 'nlm precision --days 30' to check when enough signal exists."
```

---

## Bump and Publish

After all phases are complete and green:

```bash
npm version minor  # 0.7.x → 0.8.0 (new user-facing features: better recall, precision CLI)
git push origin main --follow-tags
npm publish
```

---

## What "A" Looks Like After This

| Metric | Before | After |
|---|---|---|
| Short prompt recall noise | "yes please" → wrong sessions | "yes please" → empty (correct) |
| Precision measurement | No real-world number | `nlm precision` shows P@k |
| Signal loop | 0 real citation entries | Citations accumulate from agent behavior |
| Reranker | FTS5 rank only | FTS5 + citation frequency |
| Vuln count | 5 (1 critical) | 0 (cleared in 0.7.0) |
