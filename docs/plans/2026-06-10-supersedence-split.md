# Supersedence split: `replaces` vs `supersedes`

**Status:** approved 2026-06-10 (Edward). Tracked as NLM Tasks #298 (core) and #299 (Thread UI).
**#298 landed 2026-06-10:** types, both stores (`insertSession` kind-aware `Supersedes`), scheduler call site (`replaces`), recall predicates (`NOT IN ('superseded','replaced')`), cycle detection over the union, `nlm doctor` I2 split (added `I2r`) + I3 union, dataset (`replaced` status + `replaces`/`replaced_by` edges), `liveSessionStatus` short-circuit, SQLite migration 019 (table-rebuild CHECK widen via a new `-- nlm:no-wrap` runner directive) + PG one-shot `migrations/pg/019_split_replaces.sql`. `markSuperseded` semantics unchanged. Migration sanity-checked on a /tmp copy of `~/.nlm/canonical.sqlite` (018 then 019): before 2765 closed / 187 superseded / 196 supersedes edges (183 self-loops) → after 018+019 2939 closed / 13 replaced / 0 superseded / 13 replaces edges; `integrity_check ok`, zero orphans. The 13 surviving real edges all shared a transcript_path, so all reclassified as `replaces` (none were operator supersedences). #299 owns the Thread/status-chip UI affordance.
**Prerequisites:** commits c4834f0..d9ee06b pushed and daemon restarted (repair migration 018 applied); `nlm doctor` (#297) landed.

## Problem

Two different relations are stored as one `supersedes` edge kind and one `superseded` status:

1. **Mechanical replacement.** The supersede-on-resume design (see `Ventures/nlm-memory/learnings.md`, Phase 2 build patterns): a transcript file grows after classification, the whole file is re-parsed, and the new session record supersedes the prior parse. The old record is a strict subset of the new one. This is plumbing.
2. **Epistemic overturn.** The operator (via UI palette, CLI `nlm supersede`, or HTTP) asserts that one session's reasoning overturned another's. This is meaning — the product's core thesis.

Consequences of the overload:

- The provenance-integrity KPI counts plumbing and meaning together.
- Thread dims mechanically-replaced sessions identically to overturned ones, implying reasoning was rejected when it was merely re-parsed.
- The 2026-06-10 self-supersede corruption (181 rows) was born in the mechanical case — the overload made the ingest path a writer of an operator-semantics edge.
- For the future remote-team shared knowledge base (the reason the PG tier exists), "whose reasoning overturned whose" must be trustworthy; mixing re-parses into that relation poisons it at team scale.

## Design

### Data model

- New edge kind: `replaces` (alongside `supersedes`) in `session_edges.kind`.
- New session status: `replaced` (alongside `active`/`closed`/`superseded`).
- Status chosen over edge-kind-only because recall filters, Thread rendering, and metrics all read status; deriving meaning from edges on every read path is the expensive option. This is the one decision that is annoying to reverse — approved 2026-06-10.

### Write paths

| Path | Edge kind | Status set on predecessor |
|---|---|---|
| Scheduler ingest (`insertSession` with supersedes param, i.e. supersede-on-resume) | `replaces` | `replaced` |
| `markSuperseded` (UI palette / CLI / HTTP — operator-asserted) | `supersedes` | `superseded` |

`insertSession`'s parameter should be renamed or typed to carry the kind explicitly (e.g. `{ priorSessionId, kind: "replaces" }`) rather than a second boolean — the call sites are the scheduler (replaces) and tests.

### Consumer semantics

| Consumer | Behavior after split |
|---|---|
| Recall (`semanticSearch`/`keywordSearch`, both backends) | `status NOT IN ('superseded','replaced')` — update the predicates landed in d9ee06b |
| Thread | `replaced` collapses behind "N earlier versions" affordance (#299); `superseded` stays dimmed-but-visible |
| Search / Pulse Recent Sessions | `replaced` never appears; `superseded` per current behavior |
| Provenance-integrity, re-derivation metrics | Computed over `supersedes` edges only |
| Cycle detection (`markSuperseded` guard) | Applies to the union of both kinds (a replaces chain is linear by construction, but guard anyway — cheap) |
| `nlm doctor` (#297) | I1/I2/I3 extended to both kinds; I2 matches status to incoming edge kind |
| Dataset API | Exposes both statuses distinctly; UI maps them |

### Migration 019

The mechanical signature is precise, no heuristics: **an edge whose two sessions share the same `transcript_path` is a replace; different paths is operator supersedence.**

SQLite (versioned runner):

```sql
-- 019_split_replaces.sql
UPDATE session_edges SET kind = 'replaces'
WHERE kind = 'supersedes'
  AND (SELECT transcript_path FROM sessions WHERE id = from_session)
    = (SELECT transcript_path FROM sessions WHERE id = to_session);

UPDATE sessions SET status = 'replaced', updated_at = datetime('now')
WHERE status = 'superseded'
  AND id IN (SELECT to_session FROM session_edges WHERE kind = 'replaces');
```

PG: one-shot operator-applied script per the 018 convention (PG has no version-gated runner — known gap, separate concern).

### Type surface

`src/shared/types.ts`: status union gains `"replaced"`; edge kind union gains `"replaces"`. The `insertSession` guard that rejects persisting `idle` stays; `replaced` is only ever set via the edge-write path, never passed in as a record status.

## Out of scope (deliberate)

- Multi-hop replace-chain compaction (deleting intermediate parses) — violates no-deletion policy; the chain is the audit trail.
- Retroactive splitting of facts supersedence — fact chains are per-(subject,predicate) and already semantically uniform.
- PG versioned migration runner — separate task if/when the PG tier goes multi-user.

## Verification

- Resume a real session live: new record `replaced`/`replaces`; `nlm doctor` green.
- `markSuperseded` round-trip unchanged.
- Migration on a prod copy: post-018 mechanical rows convert; the 13 operator supersedences (same count as the 018 repair preserved) untouched unless they share a transcript_path, which by definition makes them mechanical.
- Recall excludes both statuses; Thread renders the two treatments distinctly.
