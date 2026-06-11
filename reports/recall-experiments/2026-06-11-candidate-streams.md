# Recall candidate-stream experiment — NLM #307

**Date:** 2026-06-11
**Goal:** Recover paraphrase-type recall misses by ADDING candidate streams to
the keyword leg (ranking left untouched — mean rank is 1.52 when the candidate
is found). Measure each arm on the fixed 40-query decision set, ship only arms
that improve R@5 without a >2x latency regression.

**Query set:** 40 gold-labeled decision queries (path:
`/tmp/nlm-precision-sim/decision-queries.txt`; not committed — contains project
and client names). Misses below are listed by question number only.

**Corpus:** copy of production canonical.sqlite, 2,968 sessions, on port 3946
under `HOME=/tmp/nlm-307`. Production daemon (3940, `~/.nlm`) untouched.

## Store availability

| Store | Count | Status |
|-------|-------|--------|
| sessions | 2,968 | populated |
| facts | 10,468 | populated (no backfill needed) |
| session_entities | 26,498 | populated |
| entities | 6,351 | populated |
| session_embedding_chunks | present | populated (sqlite-vec) |
| Ollama embedder (localhost:11434) | up | Arms C + D runnable |

## Results vs baseline

Baseline = keyword-only recall (the shipped, hook-path config). All arms
measured on the identical 40-query set at limit=5.

| Arm | Description | R@5 | R@1 | Mean rank | Avg latency | Verdict |
|-----|-------------|-----|-----|-----------|-------------|---------|
| **Baseline** | keyword-only | **72.5% (29/40)** | **52.5% (21/40)** | **1.52** | 44 ms | reference |
| A | facts-lane merge | 72.5% (29/40) | 52.5% (21/40) | 1.52 | 53 ms | no change → reject |
| B | entity-match leg | 72.5% (29/40) | 52.5% (21/40) | 1.52 | 46 ms | no change → reject |
| A+B | both | 72.5% (29/40) | 52.5% (21/40) | 1.52 | 44 ms | no change → reject |
| C | semantic cascade-fallback | recovers 0 misses (see below) | — | — | ~63 ms (semantic leg) | reject |
| D | hybrid RRF blend (control) | **65% (26/40)** | 32.5% (13/40) | 2.08 | 116 ms | **regression** → reject |
| (semantic alone) | reference only | 30% (12/40) | 17.5% (7/40) | 2.00 | 63 ms | — |

Baseline miss set (all arms reproduced it unchanged): Q3, Q9, Q10, Q11, Q14,
Q17, Q26, Q28, Q32, Q33, Q35.

## Why every candidate-stream arm failed

The misses are **not** a candidate-generation problem, so adding candidate
streams cannot fix them. Two distinct failure shapes:

1. **BM25 rank near-misses already in the keyword set.** For Q14, Q17, Q28,
   Q32 the gold session IS a keyword hit, sitting at rank 6–8, edged out by
   other keyword hits with marginally higher BM25 scores (e.g. Q28 gold
   matchScore 24.6 vs the rank-5 hit's 28.2). These are a *ranking* problem,
   explicitly out of scope for this task ("do not touch ranking").

2. **Genuine low-overlap paraphrases.** For Q3, Q9, Q11, Q33 the gold session
   has near-zero keyword overlap and ranks far down (18, 37, 30, 32).

Arms A/B *did* pull 10 of 11 gold sessions into the candidate set (A+B probe at
limit 50 surfaced all but Q26), but the design scores appended fact/entity
candidates BELOW the lowest real keyword hit — to honor "keyword hits keep
priority." Because the keyword leg already returns ≥200 hits per query (top-5
is always full of keyword hits), an appended candidate lands at rank ≥6 and
never enters top-5. Recovering these would require *reordering* — letting a
strong entity/fact match outrank a weak single-token keyword hit — which is
reranking, not candidate generation.

**Arm C (semantic cascade-fallback):** semantic search over the 11 keyword
misses finds only 1 (Q28) in its own top-5; the other 10 are absent from even
the semantic top-50. Q28 is already a strong keyword hit (5+ hits above it), so
a "keyword leg is weak" cascade trigger would not fire for it. Net recovery
under any sensible trigger: 0. The embedding lane does not capture these short
operational-decision paraphrases.

**Arm D (hybrid RRF, control):** settles the May small-haystack finding at real
scale — at 2,968 sessions, RRF-blending the weak semantic leg (30% R@5 alone)
*demotes* strong keyword winners via rank fusion, dropping R@5 to 65% and R@1
to 32.5%. Hybrid is a net negative for this corpus; keyword-only is correct for
both the hook and investigative lanes.

## Decision

**Nothing ships.** No arm improves R@5. The keyword-only recall path (hook and
investigative lanes) is unchanged. All experiment toggles and scaffolding were
removed (no dead flags, no dead code) — `src/` is byte-identical to HEAD before
this experiment.

**Follow-up (not in scope here):** the only addressable miss class is the BM25
rank near-misses (Q14/17/28/32) — candidates already present, just ranked 6–8.
That is a reranking question (e.g. an entity-overlap or fact-corroboration
tiebreaker applied to the existing keyword candidate set), to be measured
separately under a ranking-focused task.

## Verification

- `npm run typecheck`: pass
- `npx vitest run`: 992 passed / 65 skipped (baseline)
- Final harness on shipped (keyword-default) config: R@5 72.5%, R@1 52.5%,
  mean rank 1.52 — baseline reproduced.
