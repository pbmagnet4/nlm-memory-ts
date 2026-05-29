# Supersedence and the editable timeline

> Why memory in NLM is non-linear, what each status means, how supersedence flows through recall.

Most memory layers are append-only: every new fact adds to the pile, the pile grows monotonically, and stale information is either tolerated or pruned by retention rules. NLM's defining property is that the timeline is **editable** — a session recorded six months ago can be marked as superseded by a newer one, and the next recall surfaces the correction instead of the stale claim.

## The four session statuses

Session status is derived from two layers: the **persisted** status in SQLite, and the **transcript file mtime** for runtimes whose sessions are live files on disk.

| Status | When | Recall behavior |
|---|---|---|
| `active` | Transcript modified in the last 15 minutes | Surfaces normally; weighted higher in some flows |
| `idle` | Transcript modified 15 min – 24 h ago | Surfaces normally |
| `closed` | Transcript modified ≥ 24 h ago, or the file is gone | Surfaces normally |
| `superseded` | Explicitly marked because a newer session patches it | Still surfaces, but the UI and the `get_session` MCP response link to the patcher; downstream consumers can choose to follow the link instead |

The first three are computed live from `fs.statSync(transcript).mtimeMs` in `src/core/storage/live-status.ts`. The fourth is persisted explicitly and overrides everything else — once a session is `superseded`, the time-based status no longer applies.

## How supersedence is recorded

When a session is ingested with a `supersedes` pointer to an older session id, two things happen atomically in `SqliteSessionStore.insertWithEmbedding`:

1. A `supersedes` edge is written into the `session_edges` table linking new → old
2. The older session's `status` column is updated to `'superseded'` and its `updated_at` is bumped

Code: [`src/core/storage/sqlite-session-store.ts:244-252`](../src/core/storage/sqlite-session-store.ts#L244-L252).

The edge is the source of truth for which session is the patcher. Walking edges forward yields the supersedence chain.

## Reading a superseded session

`get_session` returns the full session body plus enriched supersedence pointers:

```jsonc
{
  "id": "sess_2026_03_decision_old",
  "label": "Pricing decision (initial)",
  "status": "superseded",
  "supersedes": [],                              // didn't supersede anything
  "supersededBy": {                              // got superseded by
    "id": "sess_2026_05_decision_revised",
    "label": "Pricing decision (revised after Q2 review)",
    "summary": "Bumped Track 1 from $X to $Y after Q2 client feedback..."
  }
}
```

The label + summary enrichment was added in v0.5.1. Before that, the response had opaque IDs and AI callers had to do a second round-trip to read the predecessor. Now the context arrives in one read.

## How supersedence flows through recall

Supersedence does **not** suppress the older session from search results — that would erase the audit trail and break "show me how we used to think about X" queries. Instead:

- Keyword and semantic scoring treat `superseded` and active sessions identically. Both can appear in the top 5.
- The UI's **River** page renders `superseded` sessions in a visually distinct lane (added in v0.5.1) so the operator sees the patched ones at a glance.
- Pointer-block injection (the hook surface) currently includes superseded sessions if they score highly. AI callers that want only "current" claims should call `get_session` on each hit and check the `supersededBy` field — the enrichment makes this cheap.

The design choice: **preserve the trail, mark it explicitly, let the consumer decide.** Silently filtering would destroy the corrective intent of the model.

## What about retired or aborted sessions?

NLM does not have explicit `retired` or `aborted` statuses for **sessions**. The closest semantics:

- **Retired entity** — an entity-level overlay (`retire_entity` action) hides an entity from active lists, but its sessions remain searchable. Use this when an entire project, person, or topic is no longer active. Code: `src/core/actions/overlay.ts:75`.
- **Closed session** — falls out automatically when the transcript hasn't been touched in 24+ hours. Closed is *implicit retirement*; the session is still part of the corpus but it's no longer "current."
- **Snoozed** — temporary version of retired; lifts after a set duration.

If you want to mark a session as a dead-end mid-flight ("we tried this approach, it didn't work, here's what we learned"), the right move is to **supersede it** with the session where you landed on the working approach, even if that session also documents the failure. That way the chain captures "we went here, then here, and the second one is canonical."

## Working with supersedence in practice

Three calls available via MCP:

- `recall_sessions` — returns hits across all statuses including superseded
- `get_session(id)` — returns full body + enriched supersedence links
- `cite_session(id, reason)` — explicitly mark a session as referenced by the current conversation (for `useful_hit_rate` telemetry)

There's intentionally no `mark_superseded` MCP tool today. Supersedence is recorded at session **ingest time** by the runtime adapter — the new session declares what it supersedes. Operator-driven supersedence (post-hoc patching from the UI) is on the roadmap; the underlying storage already supports it, the affordance is just missing.

## Related code

- `src/shared/types.ts` — `SessionStatus` type definition
- `src/core/storage/sqlite-session-store.ts` — insert path that writes the edge and updates the old status
- `src/core/storage/live-status.ts` — mtime → status derivation
- `src/core/actions/overlay.ts` — entity-level retire/snooze/label overlays
- `src/mcp/server.ts` — `get_session` enrichment that surfaces supersedence labels to callers
- `src/ui/pages/River.tsx` — superseded-lane rendering
