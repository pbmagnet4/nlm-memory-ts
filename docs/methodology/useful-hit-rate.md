# useful_hit_rate — design

## Why

`hit_rate` reports the fraction of recall calls that returned ≥1 row. With the MCP default now hybrid, that number is structurally close to 100% — semantic always returns *something*. `hit_rate` no longer separates "found stuff" from "found stuff that mattered." `useful_hit_rate` is the metric we actually want: the fraction of recall calls whose returned results were referenced in the next assistant turn.

This is the signal that lets us answer "is NLM serving its intended purpose" with evidence instead of opinion, and it's an input to the headline re-derivation rate metric (see [re-derivation-rate.md](re-derivation-rate.md) — pending).

## Definitions

**A recall event** is one of:
- A hook fire (logged in `~/.nlm/hook-log.jsonl` with `wouldInject` ids)
- An MCP `recall_sessions` / `recall_facts` call (logged in `~/.nlm/query-log.jsonl`)
- An HTTP `/api/recall` call (logged in `~/.nlm/query-log.jsonl`)

**A useful recall** is a recall event where:
- At least one of the returned session ids OR session labels appears in the next assistant message in the same conversation transcript, AND
- The match occurs within 3 assistant turns of the recall, AND
- The recall is not a probe (excluded query patterns: `concurrency probe`, `test probe`, `path test`, `recall test`, smoke/cutover patterns)

**`useful_hit_rate`** = (useful recalls) / (real recalls) over the reporting window.

## Detection algorithm

```
for each real recall event in window:
    transcript = find_transcript(event.conversationId)
    if transcript is None:
        mark useful = null (unmeasurable)
        continue
    next_assistant_msgs = transcript.messages_after(event.ts, role="assistant", limit=3)
    haystack = " ".join(m.content for m in next_assistant_msgs)
    for hit_id in event.returnedIds:
        if hit_id in haystack or session_label(hit_id) in haystack:
            mark useful = true; break
    else:
        mark useful = false
```

## Data flow

1. **Hook recalls** have `conversationId` directly. Transcript path: `~/.claude/projects/<sanitized-project>/<conversationId>.jsonl`.
2. **MCP recalls** currently have no conversation context in `query-log.jsonl`. Adding `x-claude-session-id` capture to the MCP server is a prerequisite for measuring MCP useful_hit_rate.
3. **HTTP recalls** are operator-driven (UI browsing) and excluded from this metric — `useful_hit_rate` measures agent recall usefulness, not UI search satisfaction.

## Storage

- New log file `~/.nlm/useful-hit-log.jsonl`, one entry per scanned recall:
  ```json
  {"ts": "...", "source": "hook|mcp", "conversationId": "...", "returnedIds": [...], "useful": true|false|null, "matchedId": "...", "scannedAt": "..."}
  ```
- New CLI: `nlm useful-scan` — scans the last 24h of recalls, joins against transcripts, appends to the log
- New endpoint field: `/api/recall/stats` includes `useful_hit_rate` and `useful_hit_count` over the same window as `hit_rate`

## Out of scope (V1)

- MCP useful_hit_rate (blocked on conversation-id capture; track as follow-up)
- Real-time useful-hit detection (V1 is batch-scan, run on the daily digest cron)
- Distinguishing "agent quoted the recall" vs "agent acted on it" (the former is a proxy for the latter; V2 could refine)
- HTTP UI click-through (different metric — would live under a separate `ui_click_rate`)

## V1 scope (shipping now)

- Ship the daily digest cron consuming existing `hit_rate` (this doc justifies the upgrade path)
- Add stub field `useful_hit_rate: null` to `/api/recall/stats` so the digest schema is forward-compatible
- Implement the scanner + CLI in a follow-up commit (target: within 7 days)

## Why batch-scan vs hook-vs-hook real-time

A second Claude Code hook (`Stop` or `PostToolUse`) could compute usefulness in real time. Rejected because:
- Doubles installation surface (two hooks per agent runtime)
- Adds per-turn latency for a metric the user reads once/day
- Doesn't generalize to Hermes, pi, Codex, Gemini, Aider (no equivalent post-turn hook on most)
- Batch-scan reads the same transcript files the daemon already polls

## Open questions

- Hit-label heuristic: substring match is cheap but noisy. Worth fuzzy matching session label tokens? Defer until V1 data shows the false-positive rate.
- Window for scan: hour-bucket vs day-bucket? Daily-bucket for now to match the digest cadence; revisit if cron interval changes.
