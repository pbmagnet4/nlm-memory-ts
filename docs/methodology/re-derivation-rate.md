# re-derivation_rate — design

## Why

`re_derivation_rate` is NLM's strategic metric — the operator-outcome number that competitors (mem0, agentmemory, Letta) cannot match because their destructive lifecycle (decay, auto-forget) erases the data needed to compute it. It is the headline number for Pulse, the cron digest, and any public marketing scorecard. Detection rule, methodology, and a reproducible script live here so the metric is auditable.

## Plain-language definition

A *re-derivation* is when an operator (you, in any AI runtime) solves the same problem twice across multiple sessions without recall of the prior solution. It is the tax NLM exists to eliminate: every re-derivation is a session where memory could have helped but didn't.

`re_derivation_rate` over a window = (re-derivation events) / (decision events) in that window.

`re_derivations_prevented` = recall events whose `useful_hit_rate` is true AND whose returned session contained the matching decision. Inverse of re-derivation: the events where memory *did* help.

## Detection rule (V1)

A pair of sessions `(A, B)` is a re-derivation iff all of the following hold:

1. **Same entity.** A and B share at least one entity in their respective `entities` arrays.
2. **Same decision normalized.** A `decision` marker in A and a `decision` marker in B normalize to overlapping content. Normalization: lowercase, strip stopwords, tokenize, Jaccard similarity ≥ 0.6.
3. **Temporal gap.** `B.started_at - A.started_at >= 7 days`.
4. **No supersedence link.** No `session_edges` row of kind `supersedes` connects A and B in either direction.
5. **No continues link.** No `session_edges` row of kind `continues` connects A and B.
6. **No intervening recall.** Between A.started_at and B.started_at, no recall event in `query-log.jsonl` or `hook-log.jsonl` returned A's id (would mean B's operator was aware of A and chose not to link).

When all six are true, `B` is a re-derivation of `A`. Count B (not A) — the metric measures fresh re-derivations, not the original.

## Edge cases and resolutions

- **Three sessions A, B, C** where B re-derives A and C re-derives B: count B and C, not A.
- **Trivial decisions.** Decisions under N tokens (default 6) are excluded — "yes ship it" is not a meaningful decision to track.
- **High-frequency entities.** If an entity has >50 sessions in the window, scale the Jaccard threshold up to 0.75 to reduce false positives (common topics will inevitably overlap in keyword-trivial ways).
- **Probe / test entities.** Sessions whose label matches probe patterns (see useful-hit-rate.md) are excluded from both sides.

## Computation algorithm

```python
def find_re_derivations(sessions, edges, recalls, window_days):
    pairs = []
    decisions = collect_decisions(sessions)  # one row per (session_id, normalized_decision_tokens, entities)
    for ent in distinct_entities(decisions):
        ent_decisions = sorted(by_session_start([d for d in decisions if ent in d.entities]))
        for i, a in enumerate(ent_decisions):
            for b in ent_decisions[i+1:]:
                if days_between(a, b) < 7: continue
                if days_between(a, b) > window_days: break
                if jaccard(a.tokens, b.tokens) < threshold(ent): continue
                if has_edge(edges, a, b, ("supersedes", "continues")): continue
                if recall_returned_a_between(recalls, a, b): continue
                pairs.append((a, b))
    return pairs
```

Runs over the existing canonical sqlite (sessions + session_edges) and the recall log jsonl files. No new schema, no migration. Computed in a single pass; results cached by `(window_start, window_end)` in a new `re_derivation_log` table.

## Storage

- New table `re_derivation_log`: `(window_start, window_end, computed_at, session_a_id, session_b_id, entity, jaccard, decision_a, decision_b)`. One row per detected pair. Re-computable; deletable; not source of truth.
- New endpoint field on `/api/recall/stats`: `re_derivation_count_7d`, `re_derivations_prevented_7d`.
- Pulse: new headline tile showing both numbers and the weekly trend.

## CLI

- `nlm re-derivation scan` — recomputes the log for a window. Default last 30 days.
- `nlm re-derivation list --since 7d` — lists detected pairs with the matched decisions for human review (false-positive triage).
- `nlm re-derivation explain <session-b-id>` — for one B, show why it was flagged (matched A, decision overlap, why no recall covered it).

## Calibration loop

Re-derivation detection is heuristic. False positives waste reader trust; false negatives undersell the metric. Calibration weekly for the first month after V1:

1. Run `nlm re-derivation list --since 7d`
2. Edward reviews each flagged pair
3. Mark `true_re_derivation: true|false` in a `re_derivation_feedback` table
4. Adjust Jaccard threshold + minimum decision length until precision/recall both > 70% on Edward's review

After 4 weeks of calibration, freeze the parameters and publish them in `docs/methodology/re-derivation-rate.md` for external use.

## Public scorecard format

For external publication (gated on the marketing-readiness checklist):

```
Edward's corpus, week of YYYY-MM-DD:
  Sessions in window:        N
  Decisions in window:       M
  Re-derivations detected:   X
  Re-derivations prevented:  Y  (recall returned the matching prior session)
  Re-derivation rate:        X / M = Z.Z%
  Methodology:               docs/methodology/re-derivation-rate.md
  Calibration set:           docs/calibration/re-derivation-2026-MM.md
```

Publish weekly to the repo. The trend (rate falling over time as NLM gets more useful) is the marketing story.

## Why competitors cannot match this

agentmemory's 4-tier lifecycle decays old observations and auto-forgets stale facts. Without the historical session record intact, there is no Session A to detect a re-derivation against — the data is gone. mem0 uses passive extraction and accretion, with no native concept of session identity that would let you pair A and B. Letta's core memory is in-context, not historical.

NLM's supersedence + full-session retention is the prerequisite for this metric. It is the strategic moat made measurable.

## Out of scope (V1)

- Cross-runtime re-derivation (decision in Claude Code, re-derived in Hermes). Requires reliable entity normalization across adapters; defer to V2.
- Semantic similarity instead of Jaccard (would catch paraphrased decisions but requires embedding every decision). Defer.
- Automatic supersedence link suggestion from detected re-derivations. The metric should measure, not act, until calibrated.

## Implementation phasing

1. **Phase 1 (after #152, #153, #154 ship):** implement detection algorithm + CLI + scan command. No UI changes. Validate on Edward's corpus.
2. **Phase 2 (after 2 weeks of calibration):** wire `re_derivation_count_7d` into `/api/recall/stats` and the daily digest. Pulse tile.
3. **Phase 3 (gated on marketing readiness):** publish first weekly scorecard publicly. Repo README. Landing site.
