# recall precision (useful-hit) — design

## Why

`hit_rate` reports the fraction of recall calls that returned ≥1 row. With the MCP default now hybrid, that number is structurally close to 100% — semantic always returns *something*. `hit_rate` no longer separates "found stuff" from "found stuff that mattered." The metric we actually want is **precision**: the fraction of *surfaced* sessions that the agent then *cited* in the same conversation. A surfaced session is useful when it is later cited.

## Derived, not written

There is no separate `useful-hit-log.jsonl` writer. An earlier V1 (`src/core/recall/useful-scan.ts`, removed in `4f8fb66`, May 31 2026) tried to detect usefulness by scanning assistant transcripts for surfaced session ids. It was structurally stuck at 0%: NLM injects sessions as silent context, so the assistant never echoes ids back into prose and the substring scan never fired.

The metric is now **derived at read time** by `nlm precision` from two append-only logs that the running system already produces:

- **Surfaced set** — `~/.nlm/hook-log.jsonl`. Each prompt-recall fire (`recall` entry) records `conversationId` + `wouldInject` (the injected session ids). This is the join substrate because it reliably carries the real Claude Code `session_id`.
- **Cited set** — `~/.nlm/citation-log.jsonl`. The Stop hook (prose + tool-use detection) and the `cite_session` MCP tool both append `(conversation_id, cited_id)` rows.

Join by `conversationId`: a surfaced id that also appears in the cited set is a hit. Precision per conversation = hits / surfaced; the blended number averages over conversations.

`query_log.jsonl` is **not** the surfaced substrate for the blended number — it almost never captured `conversation_id` historically, so joining on it collapsed every recall into a single `"unknown"` bucket and produced a meaningless score. `query_log` is used only for the per-source breakdown below, because it is the only recall log carrying a `source` field.

## Per-source precision

`nlm precision` also reports precision per recall source (`hook`, `session-start-hook`, `mcp`, `http`) from `query_log` ⋈ `citation-log`. A source is only scored when at least one of its entries carries a real `conversation_id` and ≥1 returned id. Sources that never capture a `conversation_id` (currently `mcp`, `http`, and test probes) are listed as **unmeasurable** rather than reported at a fabricated 0%. As `conversation_id` capture rolls out to more lanes, more sources become measurable with no code change.

## Why blended precision is low and that is fine

The hook lane surfaces "possibly relevant" sessions on nearly every prompt; most are never cited, which is correct behaviour, so blended precision is structurally low. The signal worth tracking is **per-source** precision and its trend — the deliberate lanes (mcp, session-start) are where precision is meaningful — not the blended figure in isolation.

## Output

- `nlm precision [--days N] [--verbose] [--json]`
- Human: blended line + per-source table + unmeasurable-source list; `--verbose` adds the per-conversation breakdown (worst first).
- `--json`: `{ precisionAtK, conversationCount, perConversation, perSource, unmeasurableSources }`.
