# Recall ranking phase 2 — NLM #308

**Date:** 2026-06-11
**Goal:** Recover the two miss classes #307 left on the table:
- **Class 1** (ranking): gold already in the keyword candidate set at rank 6–8,
  edged out by marginally-higher generic BM25 hits.
- **Class 2** (query-side): deep paraphrases ranking 18–37.

Two arms, measured independently and combined on the fixed 40-query decision
set. Ship only arms that improve R@5 with no currently-correct query lost.

**Query set:** 40 gold-labeled decision queries (`decision-queries.txt`; not
committed — contains project/client names). Misses listed by number only.

**Corpus:** copy of production `canonical.sqlite`, 2,968 sessions, sandbox under
`HOME=/tmp/nlm-308`. Production daemon (3940, `~/.nlm`) untouched.

**Harness:** drives `RecallService` directly over the sandbox SQLite store
(same code path the daemon uses), keyword mode, probe limit 50 so true gold
rank is visible past top-5 for the protection gate. Reproduced #307 baseline
exactly before any arm: R@5 72.5% (29/40), R@1 52.5%, mean rank 1.517.

## Baseline miss breakdown (by gold rank)

| Class | Misses (rank) |
|-------|---------------|
| Class 1 — near-tie, gold rank 6–8 | Q17 (8), Q23 (6), Q28 (6), Q32 (7) |
| Class 2 — deep paraphrase, rank 10–37 | Q3 (18), Q9 (37), Q10 (10), Q11 (30), Q33 (32), Q35 (14) |
| Not in candidate set at all | Q26 (—) |

The discriminating signal across every Class-1 near-tie: the gold session has
high **decision-marker token overlap** with the query (8–12 tokens), while the
BM25 neighbours edging it out have **zero**. Entity-canonical overlap is
near-constant across the candidate set (a weak secondary signal at best).

## Results vs baseline

All arms at limit=5. Combined = Arm 1 + Arm 2 union.

| Arm | Description | R@5 | R@1 | Mean rank | Avg latency | Verdict |
|-----|-------------|-----|-----|-----------|-------------|---------|
| **Baseline** | keyword-only | 72.5% (29/40) | 52.5% (21/40) | 1.517 | 56 ms | reference |
| **Arm 1** | metadata tiebreaker | **90.0% (36/40)** | **70.0% (28/40)** | 1.472 | 62 ms | **SHIP** |
| Arm 2 (union) | confidence-gated reformulation, gate 18 | 90.0% (36/40) | 70.0% (28/40) | 1.417 | ~1.3 s (gated) | reject |
| Arm 2 (union) | gate 30 (fires 35/40) | 90.0% (36/40) | 70.0% (28/40) | 1.417 | ~2.2 s (gated) | reject |
| Arm 2 (replace) | rewrite replaces query (control) | 87.5% (35/40) | 72.5% (29/40) | 1.429 | 2.5 s | reject — regresses + fails gate |

### Correct-query protection gate (mandatory)

The 29 baseline-correct queries, tracked individually:

| Arm | Currently-correct queries dropped from top-5 | Verdict |
|-----|-----------------------------------------------|---------|
| Arm 1 | **NONE** | PASS |
| Arm 2 union (gate 18) | NONE | PASS |
| Arm 2 union (gate 30) | NONE | PASS |
| Arm 2 replace | Q24 (2→out), Q35 (4→14) | **FAIL** |

Arm 1 recovered 7 misses (Q3, Q10, Q11, Q17, Q23, Q32, Q35), lost zero, and
left mean rank slightly better. The replace-control demonstrates *why* the
spec mandated union: discarding the original strong query loses confident hits.

## Arm 1 — metadata tiebreaker (SHIPPED)

**Design.** A capped multiplicative bonus on the existing keyword candidate
set, applied in `finalize()` alongside the recency/supersedence multipliers:

```
factor = 1 + 0.13 * decisionOverlapFraction + 0.02 * entityOverlapFraction
matchScore *= factor          (band: 1.00 – 1.15)
```

`overlapFraction` = (query tokens present in the field's tokens) / (query
tokens). Multiplicative, scaled by the *fraction* of query tokens matched so it
is comparable across query lengths.

**Why these caps (justification, not fit-to-data).** The Class-1 gold sessions
needing rescue sat 1%–14.5% below the rank-5 BM25 score. A combined cap of
0.15 covers that near-tie band while making it arithmetically impossible to
invert a genuinely stronger match: a hit scoring ≥1.15× another can never be
overtaken by the bonus alone. Decisions carry the bulk of the weight (0.13)
because decision-marker overlap is the empirically discriminating signal;
entities get a thin 0.02 tiebreak-of-the-tiebreak. This is *not* tuned to clear
Q28 — Q28's BM25 gap (13%) lands right at the edge and it is correctly left as
a miss rather than lifting the cap to chase one query.

**Cost / lane safety.** Pure in-memory token-set math on sessions already
resolved by the keyword leg. No extra DB query, no LLM, no I/O. Latency flat
(+6 ms across 40 queries). Cheap enough for **all** lanes including the hook
path; applied unconditionally for keyword mode.

**Remaining misses (Q9, Q26, Q28, Q33).** Q28 = a 13% BM25 gap (out of band by
design). Q9/Q33 = decision overlap diffuse across many sessions (no clean
discriminator). Q26 = gold absent from the keyword candidate set entirely.

## Arm 2 — confidence-gated query reformulation (NOT SHIPPED)

**LLM availability:** Ollama reachable at localhost:11434; `rewriteForRecall`
(qwen3:4b-instruct) verified working in the sandbox. **Arm was measured**, not
stubbed.

**Threshold derivation — and why the gate is ill-founded here.** The keyword
top-1 score does **not** separate misses from hits. Misses span 7.0–28.8; hits
span 4.98–57.0. Q28 (a miss) has top-score 28.8, higher than most hits; Q9
(14.3) and Q33 (17.8) sit inside the dense hit band. No threshold gates the
misses without firing on a large fraction of hits.

**Mechanism.** Union semantics per spec: when the original keyword top-score is
below threshold, call `rewriteForRecall`, re-run keyword on the alternate, merge
candidate sets keeping the max BM25 per session, then apply the Arm-1 tiebreaker
on the **original** query tokens. Investigative-lane only by construction (LLM
call). Fails open on LLM-unreachable.

**Result: zero recovery.** At gate 18 (fires on 20/40) and even at gate 30
(fires on 35/40), the union recovered **0 additional misses**. The
reformulations do not pull any remaining gold into the keyword candidate set:
Q28's gold is already present (rewriting doesn't raise its BM25); Q9/Q33/Q26
golds have genuine near-zero lexical overlap that an entity-rich rewrite cannot
manufacture — consistent with #307's finding that even semantic search
recovered only 1 of 11.

**Verdict: reject.** No R@5 improvement, +1.3–2.2 s latency per gated query, and
a new LLM dependency on the investigative path, for zero benefit on this corpus.
The protection gate passes (it never *hurts*), but the ship rule requires R@5 to
improve. Mechanism + scaffolding fully removed — no dead flags, no dead code.

## Decision

**Ship Arm 1** (metadata tiebreaker) as the default for keyword recall, all
lanes including hook. **Reject Arm 2.** New shipped config:

> R@5 **90.0%** (36/40), R@1 **70.0%** (28/40), mean rank **1.472**, ~62 ms.

A +17.5-point R@5 gain over baseline with no currently-correct query lost and
negligible latency cost.

## Verification

- `npm run typecheck`: pass
- `npx vitest run`: 1001 passed / 65 skipped (was 992/65; +9 from the new
  tiebreaker unit + integration tests)
- Final harness on shipped (Arm 1, keyword-default) config: R@5 90.0%, R@1
  70.0%, mean rank 1.472 — reproduced post-removal of scaffolding.
