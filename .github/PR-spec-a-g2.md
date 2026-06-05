# Recall + classifier improvements: specs A → G.2 + cross-cutting verification

Eight tightly-scoped improvements to NLM's recall stack, grouped into three commits for review. Branch name is `spec-a-qwen3-default` (only the first work) but the history makes the full scope clear.

## What's in here

| Spec | Commit | Summary | Risk-bounding |
|---|---|---|---|
| **A** | a01af8c | Flip local classifier default from `phi4-mini:latest` to `qwen3:4b-instruct-2507-q4_K_M` (per the 2026-06-02 head-to-head bench). `nlm setup` wizard offers to auto-pull qwen3:4b when missing. | Default-only — existing installs keep whatever classifier they configured. |
| **B** | a01af8c | Rules-file nudge for Cursor / Windsurf / OpenCode. `nlm connect <runtime> --with-rules` writes a static recall-first instruction into the runtime's documented rules path. README runtimes table reconciled with reality (Codex hooks were already shipped). | Optional flag, sentinel-wrapped writes are idempotent; disconnect removes only the managed block. |
| **C** | a01af8c | Opt-in LLM query rewriting before recall. New `rewriteForRecall` LLM port method (Ollama + DeepSeek impls). MCP `recall_sessions` defaults rewrite=on; the HTTP hook caller server-side forces rewrite=off via the `x-recall-source: hook` header so the ~400ms hot path stays clean. | Fail-open on any LLM error → raw query is used. Hot path protected even on misconfiguration. Global disable via `NLM_RECALL_REWRITE_DEFAULT=false`. |
| **D-harness** | d4a2d66 | LongMemEval-S scorer now emits R@1 + R@3 alongside R@5. The 13-point R@5→R@1 hybrid gap (96.5% → 83.5% at n=200) is the measured headroom for a future cross-encoder reranker. Spec D paused per Option 2 — measure first. | Pure instrumentation; no recall behavior change. |
| **F** | d4a2d66 | Recency weighting on every recall score. Exponential half-life multiplier capped at 1.0 (clock skew) and floored at 0.25× (so a perfect-match ancient session can still surface). Applied once at `finalize()` so keyword/semantic/hybrid all benefit uniformly. | Disable globally via `NLM_RECALL_DECAY_HALF_LIFE_DAYS=0`. LongMemEval-S R@5 keyword unchanged at 100% (dataset has clustered timestamps so multiplier is approximately flat). |
| **E** | d4a2d66 | Recall miss log + `nlm misses` CLI. The Stop hook now emits a JSONL event whenever the agent explicitly fetched a session via `get_session`/`cite_session` that the hook never surfaced. Passive logging only — no automatic reclassification or learned boost yet. | Disable via `NLM_MISS_LOG_ENABLED=0`. Fail-open on any write error. |
| **G.1** | ef78b0c | Fact corroboration scoring. `recall_facts` results now carry `corroborationCount` — distinct sessions across the full fact history that asserted the same `(subject, predicate, value)`. Log-scale multiplicative boost capped at 2.0×. | Cap at 1.0 via `NLM_FACT_CORROBORATION_BOOST_CAP=1.0` to keep counts in response but disable scoring impact. Fail-open on DB error. |
| **G.2** | ef78b0c | Hook pointer block now includes a "Known facts about top entities" section alongside the session list. Renders `<subject> <predicate>: <value> [N sessions]` per fact. All four hook runtimes (Claude Code, Codex CLI, Hermes Agent, pi.dev) get it through a single `formatPointerBlock` change. | Multiple bounding levers: `NLM_HOOK_INJECT_FACTS=0` (off), `NLM_HOOK_FACT_LIMIT` (default 5), `NLM_HOOK_FACT_MIN_CORROBORATION` (default 2), `NLM_HOOK_FACT_MIN_CONFIDENCE` (default 0.7). |
| **Task 274** | ef78b0c | Cross-cutting HTTP contract verification. 6 new e2e integration tests cover the daemon-side contract every hook runtime relies on. `scripts/verify-recall-stack.sh` is an 8-step curl + jq smoke test against the live daemon. `docs/testing-recall.md` is the per-runtime live-test checklist. | Live runtime tests deferred to operator action — see "After merge" below. |

## Verification

- `npx tsc --noEmit` clean
- `npm test` — **840 passed, 35 skipped (Postgres-only), 0 failed** (was 759 at branch base; +81 net)
- `./scripts/verify-recall-stack.sh` against a running daemon confirms the HTTP contract end-to-end (rebuild + restart the daemon first — see "After merge")
- LongMemEval-S body-only at n=200:

| Mode | R@1 | R@3 | R@5 |
|---|---|---|---|
| keyword | 81.5% | 93.0% | 96.0% |
| semantic | 68.5% | 87.0% | 91.0% |
| hybrid | 83.5% | 93.5% | 96.5% |

(Keyword R@5 = 96.0% body-only at n=200; the README's headline 97.2% is on the personal 14-month corpus with classifier-in-the-loop, not directly comparable.)

## After merge

These are operator actions the PR can't automate:

1. **Rebuild + restart the daemon.** Spec G.2 reaches the model only when the daemon binary contains the new code:
   ```sh
   npm run build && nlm restart
   ```
2. **Run the smoke test.** Confirms the HTTP contract works against the running daemon:
   ```sh
   ./scripts/verify-recall-stack.sh
   ```
3. **Walk the per-runtime live checklist.** `docs/testing-recall.md` covers the four hook runtimes (Claude Code is the highest-traffic one; the others can wait). Each takes 2–3 minutes — fire a history-flavored prompt, confirm the new "Known facts about top entities" section renders.

## Risk notes

- Each spec has an env-var off-switch. Setting all of them to disable returns the recall behavior to the pre-PR baseline.
- The 15 LLMClient test stubs grew a no-op `rewriteForRecall` method. `vitest.config.ts` sets `NLM_RECALL_REWRITE_DEFAULT=false` in the test env so tests that don't exercise rewrite don't trigger it accidentally.
- Backwards compat:
  - `formatPointerBlock(hits)` still works (facts param defaults to `[]`)
  - `runHook.recall` accepts both the old bare-hit-array return AND the new `{hits, facts}` shape
  - `RecallService` works without `factStore` wired — just doesn't emit facts even if asked
  - Existing `/api/recall` callers that ignore unknown fields see no behavior change (the `relatedFacts` field is omitted unless explicitly requested)

## What's NOT in here

- **Spec D (cross-encoder reranker)** — paused per Option 2. The R@1/R@3 instrumentation in this PR is the prerequisite measurement; the reranker itself awaits a decision on whether to take the new model dependency (e.g., `bge-reranker-base` via Ollama).
- **Automated reclassification of missed sessions (spec E follow-up)** — passive logging only for now; the miss log is the substrate for any future learned ranker.
- **Per-runtime live smoke tests** — manual, tracked under NocoDB task 274.
- **NocoDB task 273** (automated entity typing, P3) and **task 275** (`session_edges 'continues'` ingest path, P3) — parked.

## NocoDB tasks closed by this PR

- 270 — Recency weighting (spec F) ✅
- 271 — Fact corroboration (spec G.1) ✅
- 272 — Hook fact injection (spec G.2) ✅
- 274 — Cross-cutting hook verification: **HTTP contract done; per-runtime live tests deferred** ⏳

## Files

50 changed files; +3,549 / −106 lines net across three commits. See per-commit diff stats:

- `git show --stat a01af8c` — specs A + B + C
- `git show --stat d4a2d66` — specs F + E + D-harness
- `git show --stat ef78b0c` — specs G.1 + G.2 + task 274
