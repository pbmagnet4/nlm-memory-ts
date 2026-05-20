# NLM Auto-Inject Recall Hook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code `UserPromptSubmit` hook that automatically surfaces relevant prior NLM sessions as pointer blocks, gated for relevance, defaulting to a non-injecting shadow mode.

**Architecture:** Small focused modules under `src/core/hook/` (a pure gate, pure selection + rendering, file-backed memo + shadow log, Claude settings editor) plus a thin orchestrator at `src/hook/prompt-recall-hook.ts` that Claude Code invokes per prompt. The orchestrator reads the prompt from stdin, runs the gate, queries the existing `/api/recall` HTTP endpoint, dedups against a per-conversation memo, and in `live` mode emits a capped pointer block — in `shadow` mode it only logs. Every error path is fail-open (exit 0, no output).

**Tech Stack:** TypeScript (NodeNext, strict), better-sqlite3-based repo, vitest, Node 22 global `fetch`. Hexagonal — core modules are pure or file-I/O only; the orchestrator is the composition point.

**Spec:** `docs/plans/2026-05-20-recall-hook-design.md` (read it for rationale).

**Branch:** Create and work on `feat/recall-hook` off `main`.

**Conventions to follow:**
- File-path/env override pattern from `src/core/recall/query-log.ts`: a path defaults to `~/.nlm/...` but is overridable by an env var (used for testability). Mirror it for the hook log, memo dir, and Claude settings path.
- Path aliases: `@core/*`, `@ports/*`, `@shared/*` (see `tsconfig.json`).
- `dist/` is committed in this repo. Rebuild it in the final task.
- Tests: pure modules → `tests/unit/core/hook/`; file-I/O modules → `tests/integration/`.

**Out of scope:** Hermes/Codex hooks, local-LLM gating, content (non-pointer) injection, multi-machine. Do not build these.

---

## Task 1: Prompt gate (pure)

A pure classifier: is a prompt obviously generative (skip recall) or should it be evaluated? Conservative generative *excluder* — default is `evaluate`; only high-precision generative openers short-circuit. Rationale: a false `generative` wrongly skips recall (the failure we are fixing); a false `evaluate` just wastes a cheap query. Bias toward `evaluate`.

**Files:**
- Create: `src/core/hook/gate.ts`
- Test: `tests/unit/core/hook/gate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/hook/gate.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { classifyPrompt } from "../../../../src/core/hook/gate.js";

describe("classifyPrompt", () => {
  it("classifies obvious generative openers as generative", () => {
    expect(classifyPrompt("draft a LinkedIn post about FTS5")).toBe("generative");
    expect(classifyPrompt("write the migration")).toBe("generative");
    expect(classifyPrompt("brainstorm names for the feature")).toBe("generative");
    expect(classifyPrompt("Create a test file")).toBe("generative");
  });

  it("classifies retrospective prompts as evaluate", () => {
    expect(classifyPrompt("what did we decide about pgvector")).toBe("evaluate");
    expect(classifyPrompt("have I worked with this client before")).toBe("evaluate");
    expect(classifyPrompt("why is the recall backend returning zero results")).toBe("evaluate");
  });

  it("strips leading filler before checking the opener", () => {
    expect(classifyPrompt("can you write a script")).toBe("generative");
    expect(classifyPrompt("please draft the email")).toBe("generative");
    expect(classifyPrompt("could you tell me what we decided")).toBe("evaluate");
  });

  it("defaults to evaluate for empty or ambiguous prompts", () => {
    expect(classifyPrompt("")).toBe("evaluate");
    expect(classifyPrompt("the FTS5 work")).toBe("evaluate");
    expect(classifyPrompt("fix the failing test")).toBe("evaluate");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/core/hook/gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the gate**

Create `src/core/hook/gate.ts`:

```typescript
/**
 * Prompt gate for the recall hook. Pure — no I/O.
 *
 * A conservative generative *excluder*: the default is "evaluate" (query
 * recall); only high-precision generative openers short-circuit to
 * "generative". A false "generative" wrongly skips recall — the exact
 * failure this feature fixes — so the generative set is deliberately tight.
 * It is calibrated further against shadow-mode logs.
 */

export type PromptClass = "generative" | "evaluate";

const LEADING_FILLER =
  /^(please|can you|could you|would you|will you|i need you to|i'd like you to|i want you to|i would like you to|help me|let's|lets|hey|ok|okay)\b[\s,]*/i;

const GENERATIVE_OPENER =
  /^(write|draft|create|compose|generate|brainstorm|design|outline|sketch|invent|rename|come up with)\b/i;

export function classifyPrompt(prompt: string): PromptClass {
  let p = prompt.trim();
  for (let i = 0; i < 3 && LEADING_FILLER.test(p); i++) {
    p = p.replace(LEADING_FILLER, "");
  }
  return GENERATIVE_OPENER.test(p) ? "generative" : "evaluate";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/unit/core/hook/gate.test.ts`
Expected: PASS — all 4 cases.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/recall-hook
git add src/core/hook/gate.ts tests/unit/core/hook/gate.test.ts
git commit -m "feat: add prompt gate for the recall hook"
```

---

## Task 2: Selection and pointer rendering (pure)

Two pure modules: `select.ts` decides which recall hits to surface (score threshold, dedup against already-surfaced ids, per-fire and per-conversation caps); `pointer-block.ts` renders the chosen hits as the markdown pointer block.

**Files:**
- Create: `src/core/hook/select.ts`
- Create: `src/core/hook/pointer-block.ts`
- Test: `tests/unit/core/hook/select.test.ts`
- Test: `tests/unit/core/hook/pointer-block.test.ts`

- [ ] **Step 1: Write the failing test for selection**

Create `tests/unit/core/hook/select.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { selectHits, type RecallHitInput } from "../../../../src/core/hook/select.js";

const hit = (id: string, matchScore: number): RecallHitInput => ({
  id,
  label: `label ${id}`,
  startedAt: "2026-05-15T10:00:00.000Z",
  matchScore,
});

describe("selectHits", () => {
  it("drops hits below the score threshold", () => {
    const out = selectHits({
      hits: [hit("a", 0.9), hit("b", 0.3)],
      surfaced: new Set(),
      scoreThreshold: 0.5,
      perFireCap: 3,
      perConversationCap: 10,
    });
    expect(out.map((h) => h.id)).toEqual(["a"]);
  });

  it("drops hits already surfaced in this conversation", () => {
    const out = selectHits({
      hits: [hit("a", 0.9), hit("b", 0.8)],
      surfaced: new Set(["a"]),
      scoreThreshold: 0.5,
      perFireCap: 3,
      perConversationCap: 10,
    });
    expect(out.map((h) => h.id)).toEqual(["b"]);
  });

  it("caps the number surfaced per fire", () => {
    const out = selectHits({
      hits: [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7), hit("d", 0.6)],
      surfaced: new Set(),
      scoreThreshold: 0.5,
      perFireCap: 3,
      perConversationCap: 10,
    });
    expect(out.map((h) => h.id)).toEqual(["a", "b", "c"]);
  });

  it("respects the remaining per-conversation budget", () => {
    const out = selectHits({
      hits: [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7)],
      surfaced: new Set(["x", "y", "z", "p", "q", "r", "s", "t", "u"]), // 9 surfaced
      scoreThreshold: 0.5,
      perFireCap: 3,
      perConversationCap: 10,
    });
    expect(out.map((h) => h.id)).toEqual(["a"]); // only 1 slot left
  });

  it("returns nothing when the per-conversation cap is already met", () => {
    const out = selectHits({
      hits: [hit("a", 0.9)],
      surfaced: new Set(Array.from({ length: 10 }, (_, i) => `s${i}`)),
      scoreThreshold: 0.5,
      perFireCap: 3,
      perConversationCap: 10,
    });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/core/hook/select.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement selection**

Create `src/core/hook/select.ts`:

```typescript
/**
 * Selects which recall hits the hook surfaces. Pure — no I/O.
 *
 * Order of filtering: score threshold, then dedup against ids already
 * surfaced in this conversation, then the per-fire cap bounded by the
 * remaining per-conversation budget. Hits are assumed pre-ranked best-first.
 */

export interface RecallHitInput {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
  readonly matchScore: number;
}

export interface SelectParams {
  readonly hits: ReadonlyArray<RecallHitInput>;
  readonly surfaced: ReadonlySet<string>;
  readonly scoreThreshold: number;
  readonly perFireCap: number;
  readonly perConversationCap: number;
}

export function selectHits(params: SelectParams): ReadonlyArray<RecallHitInput> {
  const { hits, surfaced, scoreThreshold, perFireCap, perConversationCap } = params;
  const eligible = hits.filter(
    (h) => h.matchScore >= scoreThreshold && !surfaced.has(h.id),
  );
  const budget = Math.max(0, perConversationCap - surfaced.size);
  const limit = Math.min(perFireCap, budget);
  return eligible.slice(0, limit);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/unit/core/hook/select.test.ts`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Write the failing test for pointer-block**

Create `tests/unit/core/hook/pointer-block.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { formatPointerBlock } from "../../../../src/core/hook/pointer-block.js";

describe("formatPointerBlock", () => {
  it("returns an empty string for no hits", () => {
    expect(formatPointerBlock([])).toBe("");
  });

  it("renders a header, one line per hit, and the tool footer", () => {
    const block = formatPointerBlock([
      { id: "sess_a", label: "FTS5 vs pgvector decision", startedAt: "2026-05-15T10:00:00.000Z" },
      { id: "sess_b", label: "Semantic recall via sqlite-vec", startedAt: "2026-05-17T09:30:00.000Z" },
    ]);
    expect(block).toContain("## Possibly-relevant prior sessions (nlm-memory)");
    expect(block).toContain("- sess_a · FTS5 vs pgvector decision (2026-05-15)");
    expect(block).toContain("- sess_b · Semantic recall via sqlite-vec (2026-05-17)");
    expect(block).toContain("recall_sessions");
    expect(block).toContain("get_session");
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- tests/unit/core/hook/pointer-block.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement pointer-block**

Create `src/core/hook/pointer-block.ts`:

```typescript
/**
 * Renders the pointer block injected by the recall hook in live mode. Pure.
 * Pointer-only by design: ids + labels, no session content — the agent
 * pulls detail via the recall_sessions / get_session MCP tools.
 */

export interface PointerHit {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
}

export function formatPointerBlock(hits: ReadonlyArray<PointerHit>): string {
  if (hits.length === 0) return "";
  const lines = hits.map(
    (h) => `- ${h.id} · ${h.label} (${h.startedAt.slice(0, 10)})`,
  );
  return [
    "## Possibly-relevant prior sessions (nlm-memory)",
    ...lines,
    "Pull detail with the recall_sessions / get_session MCP tools if relevant.",
  ].join("\n");
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `npm test -- tests/unit/core/hook/select.test.ts tests/unit/core/hook/pointer-block.test.ts`
Expected: PASS — 5 + 2 cases.

- [ ] **Step 9: Commit**

```bash
git add src/core/hook/select.ts src/core/hook/pointer-block.ts tests/unit/core/hook/select.test.ts tests/unit/core/hook/pointer-block.test.ts
git commit -m "feat: add hit selection and pointer-block rendering for the recall hook"
```

---

## Task 3: Per-conversation dedup memo (file I/O)

Tracks which session ids have already been surfaced in a conversation, so each is surfaced at most once. One JSON file per conversation under a state directory. The directory defaults to `~/.nlm/hook-state/` and is overridable via `NLM_HOOK_STATE_DIR` for testing (mirrors the `query-log.ts` env pattern). All functions are defensive — they never throw.

**Files:**
- Create: `src/core/hook/memo.ts`
- Test: `tests/integration/hook-memo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/hook-memo.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSurfaced, recordSurfaced } from "../../src/core/hook/memo.js";

describe("hook memo", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-memo-"));
    process.env["NLM_HOOK_STATE_DIR"] = tmp;
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty set for an unknown conversation", () => {
    expect(loadSurfaced("conv-1").size).toBe(0);
  });

  it("records and reloads surfaced ids", () => {
    recordSurfaced("conv-1", ["sess_a", "sess_b"]);
    const got = loadSurfaced("conv-1");
    expect([...got].sort()).toEqual(["sess_a", "sess_b"]);
  });

  it("accumulates across multiple records and dedups", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    recordSurfaced("conv-1", ["sess_a", "sess_c"]);
    expect([...loadSurfaced("conv-1")].sort()).toEqual(["sess_a", "sess_c"]);
  });

  it("isolates conversations from each other", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    recordSurfaced("conv-2", ["sess_z"]);
    expect([...loadSurfaced("conv-1")]).toEqual(["sess_a"]);
    expect([...loadSurfaced("conv-2")]).toEqual(["sess_z"]);
  });

  it("loadSurfaced returns empty on a corrupt memo file rather than throwing", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    // overwrite with garbage
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tmp, "conv-1.json"), "{not json", "utf8");
    expect(loadSurfaced("conv-1").size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/hook-memo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the memo**

Create `src/core/hook/memo.ts`:

```typescript
/**
 * Per-conversation dedup memo for the recall hook. One JSON file per
 * conversation holds the set of session ids already surfaced, so each is
 * surfaced at most once per conversation.
 *
 * State dir defaults to ~/.nlm/hook-state/, overridable via
 * NLM_HOOK_STATE_DIR (testability — mirrors query-log.ts).
 *
 * Every function is defensive: a missing or corrupt file yields an empty
 * memo, and a write failure is swallowed. The hook must never break on memo
 * I/O.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function stateDir(): string {
  return process.env["NLM_HOOK_STATE_DIR"] ?? join(homedir(), ".nlm", "hook-state");
}

function memoPath(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return join(stateDir(), `${safe}.json`);
}

export function loadSurfaced(conversationId: string): Set<string> {
  try {
    const path = memoPath(conversationId);
    if (!existsSync(path)) return new Set();
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function recordSurfaced(
  conversationId: string,
  ids: ReadonlyArray<string>,
): void {
  try {
    const merged = loadSurfaced(conversationId);
    for (const id of ids) merged.add(id);
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(memoPath(conversationId), JSON.stringify([...merged]), "utf8");
  } catch {
    // Memo write failure must never break the hook.
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/integration/hook-memo.test.ts`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/hook/memo.ts tests/integration/hook-memo.test.ts
git commit -m "feat: add per-conversation dedup memo for the recall hook"
```

---

## Task 4: Shadow log (file I/O)

An append-only JSONL log of every prompt the hook saw — the data the relevance gate is calibrated against during the shadow window. Path defaults to `~/.nlm/hook-log.jsonl`, overridable via `NLM_HOOK_LOG`. The append is defensive (swallows its own errors — telemetry must never break the hook).

**Files:**
- Create: `src/core/hook/hook-log.ts`
- Test: `tests/integration/hook-log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/hook-log.test.ts`:

```typescript
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendHookLog, type HookLogEntry } from "../../src/core/hook/hook-log.js";

const entry = (over: Partial<HookLogEntry> = {}): HookLogEntry => ({
  ts: "2026-05-20T12:00:00.000Z",
  conversationId: "conv-1",
  promptPreview: "what did we decide about pgvector",
  gate: "evaluate",
  hits: [{ id: "sess_a", score: 0.9 }],
  wouldInject: ["sess_a"],
  estTokens: 42,
  mode: "shadow",
  ...over,
});

describe("appendHookLog", () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-hooklog-"));
    logPath = join(tmp, "hook-log.jsonl");
    process.env["NLM_HOOK_LOG"] = logPath;
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_LOG"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("appends one JSON line per call", () => {
    appendHookLog(entry());
    appendHookLog(entry({ conversationId: "conv-2" }));
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "");
    expect(first.conversationId).toBe("conv-1");
    expect(first.wouldInject).toEqual(["sess_a"]);
    expect(first.estTokens).toBe(42);
  });

  it("creates the parent directory if missing", () => {
    process.env["NLM_HOOK_LOG"] = join(tmp, "nested", "deep", "hook-log.jsonl");
    appendHookLog(entry());
    const lines = readFileSync(
      join(tmp, "nested", "deep", "hook-log.jsonl"),
      "utf8",
    ).trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/hook-log.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the shadow log**

Create `src/core/hook/hook-log.ts`:

```typescript
/**
 * Append-only JSONL log for the recall hook. One line per prompt the hook
 * evaluated. This is the dataset the relevance gate (generative patterns +
 * score threshold) is calibrated against during the shadow window.
 *
 * Path defaults to ~/.nlm/hook-log.jsonl, overridable via NLM_HOOK_LOG.
 * appendHookLog swallows its own errors — telemetry must never break the hook.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PromptClass } from "./gate.js";

export interface HookLogEntry {
  readonly ts: string;
  readonly conversationId: string;
  readonly promptPreview: string;
  readonly gate: PromptClass;
  readonly hits: ReadonlyArray<{ readonly id: string; readonly score: number }>;
  readonly wouldInject: ReadonlyArray<string>;
  readonly estTokens: number;
  readonly mode: "shadow" | "live";
}

function logPath(): string {
  return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}

export function appendHookLog(entry: HookLogEntry): void {
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Telemetry failure must never break the hook.
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/integration/hook-log.test.ts`
Expected: PASS — both cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/hook/hook-log.ts tests/integration/hook-log.test.ts
git commit -m "feat: add shadow log for the recall hook"
```

---

## Task 5: Hook orchestrator

The entrypoint Claude Code invokes per prompt. Split into a testable `runHook` (the orchestration: gate → recall → select → log → memo → return stdout text) and a thin `main` (stdin/stdout/fetch/env, fail-open). `runHook` takes the recall query as an injected dependency so it can be unit-tested with a fake.

**Files:**
- Create: `src/hook/prompt-recall-hook.ts`
- Test: `tests/integration/prompt-recall-hook.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/prompt-recall-hook.test.ts`:

```typescript
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "../../src/hook/prompt-recall-hook.js";
import type { RecallHitInput } from "../../src/core/hook/select.js";

const hits = (...ids: string[]): ReadonlyArray<RecallHitInput> =>
  ids.map((id, i) => ({
    id,
    label: `Session ${id}`,
    startedAt: "2026-05-15T10:00:00.000Z",
    matchScore: 0.9 - i * 0.01,
  }));

describe("runHook", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-hook-"));
    process.env["NLM_HOOK_STATE_DIR"] = join(tmp, "state");
    process.env["NLM_HOOK_LOG"] = join(tmp, "hook-log.jsonl");
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    delete process.env["NLM_HOOK_LOG"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("shadow mode logs but returns no stdout", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      { mode: "shadow", recall: async () => hits("sess_a") },
    );
    expect(out).toBe("");
    const log = readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim();
    expect(JSON.parse(log).wouldInject).toEqual(["sess_a"]);
    expect(JSON.parse(log).mode).toBe("shadow");
  });

  it("shadow mode does not write the memo", async () => {
    await runHook(
      { prompt: "what did we decide", conversationId: "c1" },
      { mode: "shadow", recall: async () => hits("sess_a") },
    );
    expect(existsSync(join(tmp, "state", "c1.json"))).toBe(false);
  });

  it("live mode returns the pointer block and records the memo", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      { mode: "live", recall: async () => hits("sess_a", "sess_b") },
    );
    expect(out).toContain("## Possibly-relevant prior sessions (nlm-memory)");
    expect(out).toContain("sess_a");
    const memo = JSON.parse(readFileSync(join(tmp, "state", "c1.json"), "utf8"));
    expect(memo.sort()).toEqual(["sess_a", "sess_b"]);
  });

  it("live mode dedups: a second fire does not re-surface the same session", async () => {
    const deps = { mode: "live" as const, recall: async () => hits("sess_a") };
    const first = await runHook({ prompt: "what did we decide", conversationId: "c1" }, deps);
    expect(first).toContain("sess_a");
    const second = await runHook({ prompt: "and what else did we decide", conversationId: "c1" }, deps);
    expect(second).toBe("");
  });

  it("generative prompts skip recall entirely", async () => {
    let called = false;
    const out = await runHook(
      { prompt: "draft a blog post about FTS5", conversationId: "c1" },
      { mode: "live", recall: async () => { called = true; return hits("sess_a"); } },
    );
    expect(out).toBe("");
    expect(called).toBe(false);
    const log = readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim();
    expect(JSON.parse(log).gate).toBe("generative");
  });

  it("returns empty and does not throw when recall rejects", async () => {
    const out = await runHook(
      { prompt: "what did we decide", conversationId: "c1" },
      { mode: "live", recall: async () => { throw new Error("daemon down"); } },
    );
    expect(out).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/prompt-recall-hook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestrator**

Create `src/hook/prompt-recall-hook.ts`:

```typescript
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

import { classifyPrompt } from "@core/hook/gate.js";
import { appendHookLog } from "@core/hook/hook-log.js";
import { loadSurfaced, recordSurfaced } from "@core/hook/memo.js";
import { formatPointerBlock } from "@core/hook/pointer-block.js";
import { selectHits, type RecallHitInput } from "@core/hook/select.js";

const SCORE_THRESHOLD = 0.5; // conservative start; calibrated in shadow mode
const PER_FIRE_CAP = 3;
const PER_CONVERSATION_CAP = 10;
const RECALL_LIMIT = 5;
const RECALL_TIMEOUT_MS = 1000;
const PROMPT_PREVIEW_CHARS = 200;

export type HookMode = "shadow" | "live";

export interface HookInput {
  readonly prompt: string;
  readonly conversationId: string;
}

export interface RunHookDeps {
  readonly mode: HookMode;
  readonly recall: (prompt: string) => Promise<ReadonlyArray<RecallHitInput>>;
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

  let hits: ReadonlyArray<RecallHitInput> = [];
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

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function recallOverHttp(prompt: string): Promise<ReadonlyArray<RecallHitInput>> {
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url =
    `http://localhost:${portValue}/api/recall` +
    `?q=${encodeURIComponent(prompt)}&mode=hybrid&limit=${RECALL_LIMIT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "x-recall-source": "hook" },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      results?: ReadonlyArray<{
        id: string;
        label: string;
        startedAt: string;
        matchScore: number;
      }>;
    };
    return (body.results ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      startedAt: r.startedAt,
      matchScore: r.matchScore,
    }));
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  try {
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
      { mode, recall: recallOverHttp },
    );
    if (out) process.stdout.write(out);
  } catch {
    // Fail open — never block or fail a prompt.
  }
}

// Run main() only when invoked as a script, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("prompt-recall-hook.js")) {
  void main();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/integration/prompt-recall-hook.test.ts`
Expected: PASS — all 6 cases.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — whole suite green, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/hook/prompt-recall-hook.ts tests/integration/prompt-recall-hook.test.ts
git commit -m "feat: add recall hook orchestrator (shadow/live, fail-open)"
```

---

## Task 6: Claude settings editor + `nlm hook` CLI

A module that adds/removes the hook entry in `~/.claude/settings.json`, plus the `nlm hook install` / `nlm hook uninstall` CLI subcommands wired to it.

**Files:**
- Create: `src/core/hook/claude-settings.ts`
- Test: `tests/integration/hook-claude-settings.test.ts`
- Modify: `src/cli/nlm.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/hook-claude-settings.test.ts`:

```typescript
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addHook, removeHook } from "../../src/core/hook/claude-settings.js";

interface Settings {
  hooks?: { UserPromptSubmit?: Array<{ hooks: Array<{ type: string; command: string }> }> };
}

describe("claude-settings hook editor", () => {
  let tmp: string;
  let settingsPath: string;
  const CMD = "NLM_HOOK_MODE=shadow node /abs/dist/hook/prompt-recall-hook.js";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-settings-"));
    settingsPath = join(tmp, "settings.json");
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("creates settings.json with the hook entry when the file is absent", () => {
    addHook(settingsPath, CMD);
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    const entries = s.hooks?.UserPromptSubmit ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hooks[0]?.command).toBe(CMD);
  });

  it("preserves unrelated existing settings and hooks", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "sonnet",
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
      }),
      "utf8",
    );
    addHook(settingsPath, CMD);
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings & { model?: string };
    expect(s.model).toBe("sonnet");
    const cmds = (s.hooks?.UserPromptSubmit ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    expect(cmds).toContain("other-tool");
    expect(cmds).toContain(CMD);
  });

  it("is idempotent — re-adding does not duplicate the nlm entry", () => {
    addHook(settingsPath, CMD);
    addHook(settingsPath, "NLM_HOOK_MODE=live node /abs/dist/hook/prompt-recall-hook.js");
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    const cmds = (s.hooks?.UserPromptSubmit ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    const nlmCmds = cmds.filter((c) => c.includes("prompt-recall-hook.js"));
    expect(nlmCmds).toHaveLength(1);
    expect(nlmCmds[0]).toContain("NLM_HOOK_MODE=live");
  });

  it("removeHook removes only the nlm entry and leaves others intact", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
      }),
      "utf8",
    );
    addHook(settingsPath, CMD);
    removeHook(settingsPath);
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    const cmds = (s.hooks?.UserPromptSubmit ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    expect(cmds).toEqual(["other-tool"]);
  });

  it("removeHook is a no-op when settings.json does not exist", () => {
    expect(() => removeHook(settingsPath)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/hook-claude-settings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the settings editor**

Create `src/core/hook/claude-settings.ts`:

```typescript
/**
 * Adds/removes the NLM recall hook entry in a Claude Code settings.json.
 *
 * The nlm entry is identified by its command containing the marker
 * "prompt-recall-hook.js". add is idempotent (it replaces any prior nlm
 * entry); remove strips only the nlm entry and preserves everything else.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const HOOK_MARKER = "prompt-recall-hook.js";

interface HookCommand {
  readonly type: string;
  readonly command: string;
}
interface HookEntry {
  readonly hooks: ReadonlyArray<HookCommand>;
}
interface ClaudeSettings {
  hooks?: { UserPromptSubmit?: HookEntry[] } & Record<string, unknown>;
  [key: string]: unknown;
}

function read(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Claude settings at ${path} is not a JSON object`);
  }
  return parsed as ClaudeSettings;
}

function write(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function isNlmEntry(entry: HookEntry): boolean {
  return entry.hooks.some((h) => h.command.includes(HOOK_MARKER));
}

export function addHook(settingsPath: string, command: string): void {
  const settings = read(settingsPath);
  const hooks = settings.hooks ?? {};
  const existing = hooks.UserPromptSubmit ?? [];
  const others = existing.filter((e) => !isNlmEntry(e));
  const next: HookEntry[] = [
    ...others,
    { hooks: [{ type: "command", command }] },
  ];
  write(settingsPath, { ...settings, hooks: { ...hooks, UserPromptSubmit: next } });
}

export function removeHook(settingsPath: string): void {
  if (!existsSync(settingsPath)) return;
  const settings = read(settingsPath);
  const existing = settings.hooks?.UserPromptSubmit;
  if (!existing) return;
  const kept = existing.filter((e) => !isNlmEntry(e));
  const hooks = { ...settings.hooks, UserPromptSubmit: kept };
  write(settingsPath, { ...settings, hooks });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/integration/hook-claude-settings.test.ts`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Wire the `nlm hook` CLI subcommands**

In `src/cli/nlm.ts`:

(a) Add these imports alongside the existing imports near the top of the file:

```typescript
import { addHook, removeHook } from "../core/hook/claude-settings.js";
```

(b) Add the `hook` command group immediately before the final `program.parseAsync()` call at the end of the file (after the `uninstall` command block):

```typescript
const HOOK_JS = resolve(__dirname, "../hook/prompt-recall-hook.js");

function claudeSettingsPath(): string {
  return process.env["NLM_CLAUDE_SETTINGS"] ?? join(homedir(), ".claude", "settings.json");
}

const hook = program
  .command("hook")
  .description("Manage the Claude Code recall hook");

hook
  .command("install")
  .description("Add the recall hook to ~/.claude/settings.json (shadow mode)")
  .action(() => {
    const path = claudeSettingsPath();
    const command = `NLM_HOOK_MODE=shadow node ${HOOK_JS}`;
    addHook(path, command);
    console.error(`nlm: recall hook installed in ${path} (shadow mode).`);
    console.error("  It logs to ~/.nlm/hook-log.jsonl and injects nothing.");
    console.error("  To go live later: change NLM_HOOK_MODE=shadow to live in that file.");
    console.error("  To remove: nlm hook uninstall");
  });

hook
  .command("uninstall")
  .description("Remove the recall hook from ~/.claude/settings.json")
  .action(() => {
    const path = claudeSettingsPath();
    removeHook(path);
    console.error(`nlm: recall hook removed from ${path}.`);
  });
```

Note: `resolve`, `join`, and `homedir` are already imported at the top of `nlm.ts` — do not re-import them. `__dirname` resolves to `dist/cli` at runtime, so `../hook/prompt-recall-hook.js` correctly points at `dist/hook/prompt-recall-hook.js`.

(c) Update the subcommand list in the file's top doc comment — add these two lines after the `nlm uninstall` line:

```
 *   nlm hook install   — add the recall hook to Claude Code (shadow mode)
 *   nlm hook uninstall — remove the recall hook from Claude Code
```

- [ ] **Step 6: Verify the build and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS — typecheck clean, whole suite green.

- [ ] **Step 7: Commit**

```bash
git add src/core/hook/claude-settings.ts tests/integration/hook-claude-settings.test.ts src/cli/nlm.ts
git commit -m "feat: add nlm hook install/uninstall CLI and Claude settings editor"
```

---

## Task 7: Rebuild `dist/` and update the CHANGELOG

`dist/` is committed in this repo. Rebuild it so the hook ships, and append the CHANGELOG entry per repo protocol.

**Files:**
- Modify: `dist/` (regenerated)
- Modify: `logs/CHANGELOG/CHANGELOG.md`

- [ ] **Step 1: Rebuild `dist/`**

Run: `npm run build`
Expected: `build:server` and `build:ui` both succeed. Confirm `dist/hook/prompt-recall-hook.js` and `dist/core/hook/` exist afterward. If the build fails, STOP and report the error.

- [ ] **Step 2: Append the CHANGELOG entry**

Insert this as the newest (first) dated entry in `logs/CHANGELOG/CHANGELOG.md`, immediately below the title/intro block:

```markdown
## 2026-05-20 — Auto-inject recall hook (task #144, shadow mode)

A Claude Code `UserPromptSubmit` hook that surfaces relevant prior sessions automatically, so read-side recall no longer depends on the agent choosing to call the MCP tool.

**Changes**
- `src/core/hook/` — pure gate (`classifyPrompt`), selection (`selectHits`), pointer rendering (`formatPointerBlock`); file-backed per-conversation memo and JSONL shadow log; Claude `settings.json` editor.
- `src/hook/prompt-recall-hook.ts` — orchestrator. Reads the prompt from stdin, gates it, queries `/api/recall` (`x-recall-source: hook`), dedups against the memo, logs always; in live mode emits a capped pointer block. Every path is fail-open.
- `nlm hook install` / `nlm hook uninstall` — manage the `UserPromptSubmit` entry in `~/.claude/settings.json`. Separate from `nlm install`.

**Decisions**
- Ships in shadow mode (`NLM_HOOK_MODE`, default `shadow`): logs what it would inject, injects nothing. Calibrate the gate against `~/.nlm/hook-log.jsonl` for 1-2 weeks, then flip to `live`.
- Pointer-only payload; each session surfaced at most once per conversation (dedup memo); caps of 3 per fire / 10 per conversation — keeps token cost minimal.
- Complements the MCP server (does not replace it): the hook is push/awareness, the MCP tools are pull/retrieval and the cross-runtime read path.

**State:** v0.3.0. Hook installed in shadow mode; live activation pending the calibration window.
```

If `CHANGELOG.md` now exceeds 10 `## ` date headings, move the oldest beyond 10 into `logs/CHANGELOG/CHANGELOG-2026.md` (prepend) and ensure the `_Older entries archived in CHANGELOG-2026.md_` pointer line is present at the bottom of `CHANGELOG.md`.

- [ ] **Step 3: Final verification**

Run: `npm test && npm run typecheck`
Expected: PASS — full suite green, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add dist logs/CHANGELOG/CHANGELOG.md
git commit -m "build: rebuild dist for the recall hook + CHANGELOG"
```

If Step 2 created/modified `CHANGELOG-2026.md`, `git add logs/CHANGELOG/CHANGELOG-2026.md` before committing.

---

## Self-Review

**Spec coverage:**
- Gate (heuristic prefilter, generative excluder) → Task 1. ✓
- Recall-score threshold + dedup + caps → Task 2 (`selectHits`). ✓
- Pointer-only payload → Task 2 (`formatPointerBlock`). ✓
- Per-conversation dedup memo → Task 3. ✓
- Shadow log (JSONL, est. token cost) → Task 4. ✓
- Shadow/live modes, `NLM_HOOK_MODE` default shadow, fail-open, data flow → Task 5. ✓
- `nlm hook install`/`uninstall`, separate from `nlm install`, idempotent → Task 6. ✓
- Distribution via committed `dist/` + CHANGELOG → Task 7. ✓
- Token discipline (caps, dedup, suppress empty fires, est. tokens logged) → enforced in `selectHits` (Task 2) and `runHook` (Task 5). ✓
- Failure modes (daemon down, malformed stdin, timeout, corrupt memo) → Task 5 (`main` try/catch, recall try/catch, timeout) and Task 3 (defensive memo). ✓

**Placeholder scan:** No TBDs; every code step has complete code; every command has an expected result. The `SCORE_THRESHOLD = 0.5` and the generative pattern set are intentional conservative starting values (the spec defers their calibration to the shadow window) — not placeholders.

**Type consistency:** `RecallHitInput {id,label,startedAt,matchScore}` defined in Task 2, imported unchanged by Task 5. `PromptClass` from Task 1 imported by Task 4's `HookLogEntry` and Task 5. `HookLogEntry` defined in Task 4, constructed in Task 5 with matching fields. `selectHits`/`SelectParams`, `formatPointerBlock`/`PointerHit`, `addHook`/`removeHook`, `loadSurfaced`/`recordSurfaced`, `appendHookLog`, `runHook`/`RunHookDeps`/`HookInput` — all signatures consistent between definition and call sites. `PointerHit` (Task 2) is structurally satisfied by `RecallHitInput` (Task 5 passes `selected` to `formatPointerBlock`). ✓

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-05-20-recall-hook-implementation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
