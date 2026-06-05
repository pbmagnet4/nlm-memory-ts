# Testing recall after spec F + G changes

After landing specs F (recency), G.1 (fact corroboration), and G.2 (fact injection into hooks), the pointer block agents see has a new section. This doc is the operator checklist for verifying the change on each connected runtime.

## Prerequisites

1. Build + restart the daemon so the new code is loaded:
   ```sh
   npm run build && nlm restart
   ```
2. Run the HTTP contract smoke test:
   ```sh
   ./scripts/verify-recall-stack.sh
   ```
   All checks should pass. This proves the daemon-side contract works for every hook runtime.
3. Pick a corpus that has corroborated facts. The default install has the maintainer's session history; any test with `?q=<project-name>` against a project you've talked about 3+ times should surface facts.

## The new pointer block format

When the hook fires, the model sees something like:

```
## Possibly-relevant prior sessions (nlm-memory)
- cc_xxx · PolySignal pipeline rewrite (2026-05-23)
- cc_yyy · PolySignal trade execution debugging (2026-05-21)

## Known facts about top entities
- polysignal uses: duckdb [8 sessions]
- polysignal framework: hono [3 sessions]
- polysignal deployment: docker [2 sessions]

NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved).
```

The "Known facts" section is the new piece. Facts only appear when:
- The hook is in `live` mode (`NLM_HOOK_MODE=live`).
- The top hits have entities tagged.
- Those entities have current high-confidence facts (≥ `NLM_HOOK_FACT_MIN_CONFIDENCE`, default 0.7).
- Those facts are corroborated by at least `NLM_HOOK_FACT_MIN_CORROBORATION` sessions (default 2).
- `NLM_HOOK_INJECT_FACTS` is not `0`.

If none qualify, the block degrades to the session-only format.

## Per-runtime checklist

For each runtime, send a history-flavored prompt that references a project with corroborated facts. Confirm the four boxes per runtime.

| | Test prompt | Inject path |
|---|---|---|
| **Claude Code** | "what did we decide about polysignal storage" | `~/.claude/settings.json` hook |
| **Codex CLI** | same | marketplace plugin (`UserPromptSubmit`) |
| **Hermes Agent** | same, in a Hermes session | plugin / `pre_llm_call` hook |
| **pi.dev** | same, in a pi session | pi extension `input` hook |

Per runtime:

- [ ] **Pointer block fires.** Sessions section appears (sanity check the hook fired at all).
- [ ] **Facts section renders.** "Known facts about top entities" appears beneath the sessions when the corpus has corroborated facts about the prompt's entities.
- [ ] **Liveness canary updates.** `tail -1 ~/.nlm/hook-log.jsonl` shows a fresh entry with `kind: "user_prompt_submit"` and your `conversationId`.
- [ ] **useful_hit_rate doesn't regress.** Run `nlm stats --days 7` before and after. The recall-citation correlation should hold or improve.

## Rules-file runtimes (Cursor / Windsurf / OpenCode)

These runtimes don't have a true hook — they rely on the rules-file nudge (spec B) telling the agent to call `recall_sessions` itself. Fact injection is delivered server-side in the same response, so the same Known-facts content reaches them when the agent decides to call recall.

For each:
- [ ] **Agent calls `recall_sessions`.** Ask a history-flavored question; verify in the agent's tool-call trace that `recall_sessions` was called.
- [ ] **Tool response carries `relatedFacts`.** Inspect the MCP tool response — when the call came from a hook source the response includes the `relatedFacts` field. (Default for MCP from these runtimes is OFF; the agent must pass `withRelatedFacts: true` or the user must set the env var.)

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Pointer block appears, but no "Known facts" section | Either no corroborated facts (most likely on a fresh corpus) or `NLM_HOOK_INJECT_FACTS=0` | Check `nlm recall-facts --subject <entity>` returns facts with `corroborationCount ≥ 2`. If env-disabled, remove the env var. |
| Hook fires but no pointer block | `NLM_HOOK_MODE` is `shadow` (default for fresh installs in some versions) | Set `NLM_HOOK_MODE=live` in `~/.nlm/.env` and restart Claude Code. |
| Smoke-test passes but real agents see nothing | Daemon was not restarted after `npm run build` | Run `nlm restart`. |
| Verification script exits at step D with no relatedFacts field | Daemon is running pre-spec-G.2 binary | Run `npm run build && nlm restart`. |

## What this verification doesn't cover

- **Real recall quality** — these tests confirm the format is right; they don't confirm "the right session for this question ranked first." That's measured by the personal-corpus harness (out of scope, see `docs/methodology-recall-baseline.md`).
- **Cross-corpus regression** — if you have an old miss-log baseline (spec E), run `nlm misses --days 14` before and after a week of usage to see if the new format changes miss rates.
- **Token-cost impact** — the new facts section adds ~50–100 tokens per fire. If you see context-cost regressions, dial `NLM_HOOK_FACT_LIMIT` down.

## When you're done

Update `~/.nlm/.env` if you changed any of:
- `NLM_HOOK_INJECT_FACTS`
- `NLM_HOOK_FACT_LIMIT`
- `NLM_HOOK_FACT_MIN_CORROBORATION`
- `NLM_HOOK_FACT_MIN_CONFIDENCE`

Mark NocoDB task 274 as Done with your per-runtime notes.
