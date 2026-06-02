# Hooks lifecycle

> What every NLM hook does, when it fires, what it logs, and how it stays out of the way when something goes wrong.

NLM ships hooks into three runtimes today: Claude Code, Hermes Agent, and pi.dev. Each runtime has a different host shape — Claude Code reads `~/.claude/settings.json`, Hermes Agent reads `~/.hermes/config.yaml`, and pi.dev loads a TypeScript extension declared in `~/.pi/agent/settings.json`'s `packages` array — but the orchestration is identical: classify the prompt, query the local daemon, format a pointer block, return it (live mode) or log only (shadow mode).

The hook surface is **fail-open by design**: any error yields a clean exit with no output. A broken hook never blocks the model's response. This matters because the alternative is silently breaking the user's primary tool for the sake of a memory layer's telemetry.

## Coverage by runtime

| Runtime | Surface | Events | Install |
|---|---|---|---|
| **Claude Code** | `~/.claude/settings.json` hook command, stdin → stdout | UserPromptSubmit, SessionStart, Stop, PreCompact, SubagentStart | `nlm connect claude-code` or `nlm setup` |
| **Hermes Agent** | Plugin in `~/.hermes/plugins/nlm-memory/` | Parallel set (pre-turn, post-turn, lifecycle) | `nlm connect hermes-agent` or `nlm setup` |
| **pi.dev** | Extension module loaded by pi's `packages[]` array, `pi.on("input", ...)` API | `input` only — pi has no Stop/PreCompact analogues; the passive pi adapter (`~/.pi/agent/sessions/**/*.jsonl`) covers transcript ingestion | `nlm connect pi` or `nlm setup` |

The pi.dev surface is the slimmest because the runtime exposes fewer extension points. It still runs the same `runHook` orchestration (`src/hook/prompt-recall-hook.ts`) and writes to the same `~/.nlm/hook-state/<sessionId>.json` per-conversation memo and `~/.nlm/hook-log.jsonl` log file, so cross-runtime invariants (de-dup across fires, surfaced-IDs cap, gate classification) hold regardless of where you're typing.

## The five hooks (Claude Code reference)

Claude Code is the most complete surface. Other runtimes implement a subset:

| Hook | When it fires | What NLM does | Output |
|---|---|---|---|
| **UserPromptSubmit** | Before each user prompt is sent to the model | Score the prompt against the corpus; select top-N most-relevant prior sessions; format a pointer block | Pointer block prepended to model context (live mode) |
| **SessionStart** | When a new conversation begins (including cron-fired and background agents that never trigger UserPromptSubmit) | Same logic as UserPromptSubmit, but query derived from `working_directory + project_name` since no prompt exists yet | Pointer block (live mode) |
| **Stop** | After the model's response completes | Scan the response for citations of surfaced session IDs; POST each fresh citation to `/api/recall/cite-event` | No stdout output; updates `useful_hit_rate` and citation log |
| **PreCompact** | Before Claude Code compacts the conversation | Flush the per-conversation surfaced-IDs memo and stamp a compaction record so post-compaction recalls aren't gated by stale "already surfaced" state | No stdout output; clears state |
| **SubagentStart** | When the runtime dispatches a subagent | Record the parent→subagent link so future corpus-linking logic can correlate subagent sessions back to the dispatching conversation | No stdout output; logs the parent/child IDs |

Code: [`src/hook/`](../src/hook/).

## Modes: live vs shadow

Each hook reads `NLM_HOOK_MODE` from its command env. Two values:

- **`live`** (default since v0.5.0) — UserPromptSubmit and SessionStart emit the pointer block on stdout, which Claude Code prepends to the model context. The model actually sees the recall.
- **`shadow`** — Same logic, same selection, same log entries — but stdout is empty. Nothing is injected into the model's context. Useful for measuring what *would* be surfaced without affecting model behavior.

Both modes write to `~/.nlm/hook-log.jsonl`. The `mode` field on each entry tells you which.

Toggle for an existing install: re-run `nlm hook install` after exporting `NLM_HOOK_MODE` to the desired value. The command rewrites the hook entries in `~/.claude/settings.json` with the new mode baked in.

## Selection logic (live mode)

UserPromptSubmit and SessionStart share the same selection gate. Constants from [`src/hook/prompt-recall-hook.ts`](../src/hook/prompt-recall-hook.ts):

```
RECALL_LIMIT          = 5     # fetch from /api/recall (over-fetch to absorb filtering)
SCORE_THRESHOLD       = 0     # minimum match score to surface
PER_FIRE_CAP          = 3     # max sessions surfaced in one hook fire
PER_CONVERSATION_CAP  = 10    # max total sessions surfaced across the conversation
RECALL_TIMEOUT_MS     = 2000  # abort if /api/recall takes longer
```

The selector deduplicates against surfaced-IDs memo so the same session isn't surfaced twice in one conversation. The per-conversation cap prevents an over-aggressive recall flood across many turns.

Recall is keyword-mode (`/api/recall?mode=keyword`), not hybrid. Keyword is faster (~400ms warm, ~1.4s cold) and the 14-month baseline shows it scores 97.2% R@5 on real session queries. Hybrid is available via the MCP path for callers that want it.

## The pointer block format

When the gate selects ≥1 hit, the hook emits:

```
## Possibly-relevant prior sessions (nlm-memory)
- hm_20260425_345042 · PolySignal dashboard UI specification design (2026-04-25)
- hm_20260425_f57dc7 · PolySignal paper trading layer design and implementation (2026-04-24)
- hm_20260501_34533d · ADHD Care Connect SEO audit and indexing fix (2026-05-01)
NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved).
```

Three things this format optimizes for:

1. **Compact** — ~50 tokens per hit. The whole block is a few hundred tokens at the per-fire cap.
2. **Skimmable** — date and one-line label, not full body. The model decides whether to pull more.
3. **Actionable** — last line names the MCP tools so the model knows how to dig in.

## Logging surface

| Log | Path | What goes in |
|---|---|---|
| Hook fire log | `~/.nlm/hook-log.jsonl` | One line per hook fire: ts, conversationId, gate (`evaluate` / `surface`), hits, wouldInject, estTokens, mode |
| Citation log | `~/.nlm/citation-log.jsonl` | One line per session the model cited in its response (from the Stop hook) |
| Useful-hit log | `~/.nlm/useful-hit-log.jsonl` | Joined view: each surfaced ID and whether it was later cited; powers `useful_hit_rate` |
| Query log | `~/.nlm/query-log.jsonl` | Every `/api/recall*` call with `x-recall-source` source header |
| Subagent log | `~/.nlm/subagent-log.jsonl` | Parent→subagent dispatches |

Override any with the corresponding `NLM_*_LOG` env var.

## Authentication

Hooks are server-to-server callers. When the daemon's `/api/*` gate is on (the default since v0.5.0), the hook attaches `Authorization: Bearer ${NLM_MCP_TOKEN}` to every fetch via `hookAuthHeaders()`. The token is auto-generated by `ensureMcpToken()` on first run and persisted to `~/.nlm/.env`. Hooks autoload that env at startup, so this happens transparently.

If you somehow nuke `~/.nlm/.env`, the next `nlm start` regenerates the token but the existing hook commands keep working — they re-read the env on every fire.

## The load-bearing canary

Setup-time smoke tests catch malformed hook commands at install moment, but nothing detects post-install drift: a node upgrade that moves the binary, a Claude Code hook dispatcher change, hand-edits to `~/.claude/settings.json`, a `dist/` move. Any of these silently stop the hook firing while Claude Code keeps working.

The `nlm digest` command runs a daily liveness check that catches exactly this: if Claude Code ran yesterday but no `mode: live` hook fires were logged, the digest emits a `WARN hook silent` alert with concrete next steps. Without that correlation, you'd only notice the breakage when recall mysteriously stops appearing — weeks later.

Wire `nlm digest --telegram` to cron and you get morning notification of any drift within ~24 hours of it happening.

## Cross-runtime hooks

Beyond Claude Code, NLM ships hook adapters for:

- **Hermes Agent** — pre-turn, post-turn, and lifecycle hooks via `nlm connect hermes-agent`. Endpoints: `/api/hook/hermes-agent/pre-turn`, `/post-turn`, `/session-lifecycle`.
- **Codex CLI** — installed as a marketplace plugin via `nlm connect codex`; the plugin bundles `prompt-recall-hook.mjs` and `stop-hook.mjs` from `plugin/scripts/`.

Other runtimes (Cursor, Windsurf, OpenCode, Aider, pi) integrate via MCP only — they read NLM but don't expose a hook surface for NLM to instrument.

## Related code

- `src/hook/prompt-recall-hook.ts` — UserPromptSubmit entrypoint
- `src/hook/session-start-hook.ts` — SessionStart entrypoint
- `src/hook/stop-hook.ts` — Stop entrypoint (citation detection)
- `src/hook/hook-auth.ts` — Bearer header attachment
- `src/core/hook/select.ts` — gate logic (caps + thresholds)
- `src/core/hook/pointer-block.ts` — output format
- `src/core/hook/memo.ts` — per-conversation surfaced-IDs state
- `src/core/hook/claude-settings.ts` — settings.json read/write (cross-platform command formatting)
- `src/core/digest/hook-liveness.ts` — daily canary check
