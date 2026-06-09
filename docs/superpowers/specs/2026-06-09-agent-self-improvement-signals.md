# Agent self-improvement signals — design spec

**Date:** 2026-06-09
**Status:** Approved — open questions resolved 2026-06-09 (see Resolved decisions)

## Problem

Coding harnesses produce a continuous stream of quality signal that is thrown away. A
turn-boundary quality gate (e.g. the Pi `quality-gate` extension in `pi-sandbox`) knows, every
editing turn, whether the model's code passed format/lint/typecheck/tests, how many fix
attempts it took, and which step failed. Today that signal lands in `/tmp` under a debug flag
and evaporates.

Because it evaporates, the agent never learns. The same local model fails `tsc` on async code
the 40th time exactly as it did the 1st — no accumulated memory of "this model, in this repo,
is weak at X." The fix is to capture that signal, aggregate it, and **recall it back into the
agent's context at the start of the next session**, so the agent self-corrects proactively.

NLM is the right home: it already ingests every agent session, distills facts, and surfaces
them via a prompt-recall hook. Self-improvement is a new *kind* of captured signal plus a recall
surface for it — not a new system. Putting it in NLM core makes it portable: any NLM user gets
it, and any harness in any language becomes a producer with ~5 lines.

## What already exists (reuse, do not rebuild)

- **Pluggable session adapters** — `src/core/adapters/*.ts` (claude-code, hermes, pi, codex,
  cursor, windsurf, aider, opencode, and a `jsonl-generic.ts`). Ingestion is already pluggable.
- **Ingestion pipeline** — `src/core/ingest/ingest-session.ts`.
- **Fact store with backends** — `src/ports/fact-store.ts`, `src/core/storage/{pg,sqlite}-fact-store.ts`.
  Storage abstraction already exists.
- **Fact extraction** — `src/core/facts/extract-facts.ts`, `backfill-facts.ts` (LLM-distilled).
- **Recall + the feedback hook** — `src/core/recall/`, `src/core/recall-facts/fact-recall-service.ts`,
  and crucially `src/hook/prompt-recall-hook.ts` / `recall-over-http.ts` (prepends memory to the
  agent's prompt). This is the mechanism that closes the loop.
- **Telemetry UI** — `src/ui/pages/Recall.tsx` ("adoption + coverage telemetry").
- **Own LLM clients** — `src/llm/{ollama,deepseek}-client.ts` for aggregation/summarization.

The architecture is already capture → distill → recall. This spec adds a parallel lane for
structured quality signal.

## Design

### 1. The signal contract (the portable primitive)

Producers emit a structured event. Two transports, same payload:

- **Session-embedded** (richest — co-located with the conversation that produced it): the
  harness writes a custom session entry. In Pi the imperative API is
  `pi.appendCustomEntry("nlm.signal", payload)` (writes a `custom_message` jsonl entry with
  `customType: "nlm.signal"` and the payload under `details`). NLM's existing session polling
  ingests it; the pi adapter recognizes `customType === "nlm.signal"`.
- **HTTP** (universal — any tool, any language): `POST localhost:3940/api/signal` with the
  payload. Mirrors the session-embedded path for producers NLM doesn't already ingest (CI
  scripts, hooks, non-session tools).

Payload schema (intentionally generic — NOT gate-specific):

```jsonc
{
  "v": 1,                              // schema version — additive-only within a major
  "kind": "gate" | "eval" | "review" | "test",
  "producer": "quality-gate",          // free-form id of the emitter
  "outcome": "pass" | "fail" | "fix" | "exhausted",
  "model": "Qwen3-Coder-Next-MLX-6bit",
  "repo": "<name-or-path>",
  "detail": { "step": "types", "files": ["src/foo.ts"], "attempt": 2 },
  "session": "<session-id-if-known>",  // links back to the conversation
  "ts": "2026-06-09T18:00:00.000Z"
}
```

`install_scope` is **not** part of the producer payload — it is stamped server-side at ingest
(see Layer 1/2). The producer stays dumb about which install it belongs to.

The Pi `quality-gate` extension is the **reference producer**: it emits `nlm.signal` at the
per-step point where it currently writes the `/tmp/pi-quality-gate.log` debug line (the
`debug()` call inside `runPipelines`, where `step.name`/`ok`/file-count exist) plus the
retry-exhausted path. ~8-10 lines, fail-open — never breaks the gate.

### 2. Storage + aggregation (NLM core)

- Store signals as a **distinct kind**, separate from semantic/conversational facts (different
  lifecycle — structured, not LLM-extracted; high volume; not subject to supersedence). Mirror the
  fact-store backend abstraction with a `signals` table (pg + sqlite parity), but **simpler**:
  append-only, no supersedence pointer, no embeddings.
- Roll up per `(producer, model, repo, kind, detail.step)` over a trailing window → counts, fail
  rate, n, recent failures. This is **pure SQL aggregation on read** (cheap at one-dev volume);
  no materialized rollup table in v1.
- NLM's own LLM (`src/llm/`) summarizes recurring patterns into a short natural-language failure
  mode — **but only in the UI / `nlm improve` report (Layer 5), never on the recall hot path**
  (see correction C below). The injected recall block is a deterministic template.

### 3. Recall — the actual self-improvement (NLM core)

- A core service `failure-mode-recall` produces a capped (a few lines) **"Known failure modes for
  this repo/model"** block, threshold-gated, surfaced at session start. Example injected text:
  *"This model failed `tsc` on 38% of editing turns in this repo (n=120, 14d). Write type
  annotations first; run the typecheck before moving on."*
- Block is scoped by repo (cwd) and, where the harness supplies it, the active model. Capped to
  respect the context budget. Served over `GET /api/signals/failure-modes?repo=&model=`.
- Wired into **both** harnesses (see Resolved decisions): Claude Code `session-start-hook.ts`
  (repo-scoped — Claude Code does not pass the model) and the Pi `before_agent_start` consumer
  (repo + model-scoped — Pi knows both).
- Add a **failure-modes view** to `Recall.tsx` for human inspection + an optional `nlm improve`
  report that suggests concrete actions (swap default model for repos where a model fails >X%,
  propose an `AGENTS.md` rule for the most common violation). **Surface + recommend only — no
  auto-act in v1.**

## Resolved decisions (2026-06-09)

The four open questions, decided:

- **Retention** — single append-only `signals` table; **aggregate on read**; a configurable
  retention prune (default **90 days**) runs on the existing scheduler. No materialized daily
  rollups in v1 (YAGNI — one-dev volume makes the on-read aggregation cheap).
- **Recall trigger** — **threshold-gated**. A failure mode is injected only when it crosses both a
  rate floor and a sample-size floor (e.g. `failRate ≥ 0.2` over `n ≥ 10` in the window), both
  configurable. Avoids nagging when the model is doing fine.
- **Recall scope** — **both harnesses in v1**: Claude Code SessionStart (repo-scoped) and Pi
  `before_agent_start` (repo + model-scoped). The loop closes on the harness that knows the model.
- **Privacy/scope** — **per-install scope column now**. Every signal row carries `install_scope`,
  stamped server-side at ingest from a generate-once `~/.nlm/install-id` (uuid). Recall filters by
  the local install_scope, so HTTP-pushed signals from another machine stay isolated. Local-only;
  same loopback + token boundary as the rest of the daemon. Gated by `NLM_SIGNALS_ENABLED`
  (default on). Documented: signals never leave the machine.
- **Schema versioning** — contract carries `v: 1`, stored per row; additive-only within a major;
  ingest tolerates unknown fields (forward-compatible).

## Review corrections (folded into the layers below)

- **A — Idempotent re-ingest.** `scanOnce` re-parses a session file when it grows, so embedded
  signals would re-emit on every resume. Signal `id` is **deterministic** = hash of
  `(session_id, producer, ts, step, outcome)`, inserted `ON CONFLICT DO NOTHING`. Re-ingest is a
  no-op.
- **B — Drain before classify, fail-open.** In the scheduler, classifier failure / sub-floor
  confidence both `continue` and skip the rest of the loop. Drain `chunk.signals` to the store
  **immediately after `chunksSeen += 1`**, in its own try/catch, so those paths still capture
  signals and a signal-store error never aborts session ingest.
- **C — LLM off the recall hot path.** SessionStart recall has a ~2000ms budget; an Ollama summary
  is ~5s. The injected block is a **deterministic template**. LLM polish lives only in Layer 5
  (UI / `nlm improve`). This intentionally overrides the spec's "LLM summarizes into the recall
  string" and removes the need for a summaries-cache table.
- **D — HTTP auth parity.** `POST /api/signal` rides the standard `/api/*` gate: tokenless in the
  default install, `Authorization: Bearer $NLM_MCP_TOKEN` when `NLM_UI_AUTH=cookie`. The Pi
  producer sends the bearer from `~/.nlm/.env` (same path the recall hooks use via
  `hookAuthHeaders`).
- **E — Compose at `main()`.** The failure-mode fetch is a separate `fetchFailureModeBlock()`
  concatenated in the SessionStart hook's `main()`; the existing `runHook` (session-recall hits)
  is untouched.
- **F — Producer emits per-step.** Emit point is the `debug()` call inside `runPipelines` (has
  `step.name`/`ok`/file-count) plus the exhausted/`notify` path — not one echoed log line.

**Known limitation (documented, not fixed in v1):** a degenerate session with zero message turns
returns `null` from `parseSession`, dropping any embedded signals. Acceptable because the quality
gate only fires on editing turns, which are always message turns. The HTTP transport is the escape
hatch for producers that need capture independent of session parsing.

## Implementation layers

Build in this order; each layer lands with its own tests before the next.

1. **Store** — `src/shared/types.ts` (`Signal`, `SignalInput`, `SignalKind`, `SignalOutcome`);
   `src/ports/signal-store.ts` (`insert` / `insertMany` / `listForAggregation` / `pruneOlderThan`
   / `countSince`); `src/core/storage/{sqlite,pg}-signal-store.ts` (share the existing DB handle,
   mirror the fact-store adapter); migration `017_signals.sql` (+ pg parity) with columns
   `id, v, install_scope, kind, producer, outcome, model, repo, step, detail (JSON text),
   session_id, ts, created_at` (`step` is denormalized from `detail.step` to a top-level column
   so the aggregation index can cover it; full `detail` JSON retains files/attempt), indexes on
   `(repo, model, kind, step)` and `(ts)`, **no FK to sessions** (soft link); wire `StorageContext.signals` through `ports/storage.ts`, both storage
   adapters, and the composition root `src/cli/nlm.ts`; `~/.nlm/install-id` generate-once helper.
   Tests: contract + sqlite/pg parity + idempotent insert.
2. **Ingest** — `src/core/signals/ingest-signal.ts` (validate + normalize → `Signal`, deterministic
   id, server-stamped `install_scope`, default `v:1`); `POST /api/signal` in `src/http/app.ts`;
   add optional `signals?: SignalInput[]` to `SessionChunk`; Pi adapter recognizes `custom_message`
   with `customType === "nlm.signal"`; scheduler drains `chunk.signals` before classify (correction
   B). Tests: HTTP validation/happy-path, pi adapter recognition, scheduler drains on
   skipped/failed sessions, dedupe.
3. **Aggregate** — `src/core/signals/aggregate.ts` (pure roll-up + threshold gate). Tests:
   aggregation math, threshold gating.
4. **Recall** — `src/core/signals/failure-mode-recall.ts` (repo/model/window/thresholds → templated
   block or `""`); `GET /api/signals/failure-modes`; `fetchFailureModeBlock()` in
   `session-start-hook.ts` `main()` (correction E); Pi `before_agent_start` consumer. Tests:
   above/below threshold, hook composition, integration.
5. **UI + report** — failure-modes panel in `Recall.tsx` (design-system README); `nlm improve` CLI
   report (LLM-polished summaries here); stats endpoint. Surface + recommend only.
6. **Reference producer + consumer (pi-sandbox)** — quality-gate emits `nlm.signal` (correction F,
   fail-open); `before_agent_start` injects the failure-mode block; both documented in the README
   as the integration example.

## Out of scope

- Test/review *quality* assessment (a trivial test still counts as a test). That belongs to a
  separate stronger-model review pass, not the signal lane.
- Acting on signals automatically (auto-swapping models). v1 surfaces + recommends; humans act.
