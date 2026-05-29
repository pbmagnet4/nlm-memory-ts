# Recall baseline methodology

> Where the 97.2% R@5 number on the README comes from, what it measures, and how to reproduce or extend it.

## What R@5 means

**Recall at k (R@k)** = fraction of evaluator queries where at least one ground-truth session ID appears in the retriever's top-k results. It's the standard retrieval benchmark — measures "did the right thing make it into the candidate set?" without yet asking "was it ranked first?"

For NLM, the unit is a session, not a chunk or fact. R@5 = 0.972 means: across 14 months of evaluator queries, NLM's recall surfaced the right session in the top 5 results on 97.2% of them.

## Two separate benchmarks live in the repo

### 1. LongMemEval-S (reproducible, public dataset)

The **LongMemEval-S** harness at `scripts/longmemeval/run-harness.ts` evaluates NLM against the public LongMemEval benchmark. This is the reproducible measurement anyone can run.

- **Dataset**: `longmemeval_s_cleaned.json` from the LongMemEval release. Fetch with `scripts/longmemeval/fetch-dataset.sh`.
- **Setup**: For each evaluation instance, the harness spins up an in-memory NLM corpus loaded with the haystack sessions, runs the question through one or more retrieval modes, and scores the result.
- **Modes scored**: `keyword`, `semantic`, `hybrid` (RRF-fused).
- **Ingest path**: **body-only** — skips the classifier and feeds raw transcripts straight to the indexer. This isolates the retrieval algorithm from the classifier-in-the-loop pipeline. It's also what makes the number comparable to other published R@5 figures (most published benchmarks are body-only).

**Run it:**

```sh
npm run build
node dist/scripts/longmemeval/run-harness.js \
  --variant longmemeval_s_cleaned.json \
  --modes keyword,semantic,hybrid \
  --limit 500 \
  --report-dir reports/longmemeval
```

First run is ~30 minutes (embeds the haystack with Ollama's `nomic-embed-text`). Subsequent runs are seconds — embeddings cache at `~/.cache/longmemeval/embeddings.sqlite` keyed by `sha256(kind + text)`.

**Metrics emitted:**
- `recallAtK` (the headline R@k)
- `sessionBodyHit` — NLM-specific companion that captures session-as-primary-unit value the strict-ID R@k can miss. If a session that supersedes the gold quotes its decision, the answer is still recoverable; sessionBodyHit records that.

Scoring code lives at `scripts/longmemeval/scorer.ts`. Both functions are pure and unit-tested (`tests/unit/scripts/longmemeval-scorer.test.ts`).

### 2. Personal 14-month corpus (the 97.2% README claim)

The README's 97.2% R@5 figure was measured on a 14-month real-usage corpus — the author's actual session history across Claude Code, Codex, Hermes, and others, with a curated evaluator query set drawn from real "what did we decide about X" / "how did Y end up" / "is Z still open" questions.

This baseline is **not directly reproducible** by other operators because the corpus is private session history. Two things make it credible anyway:

1. The methodology mirrors LongMemEval — body-only retrieval, R@k at k=5, ID match against ground truth.
2. The keyword mode that achieves this number is the same code path you'll run. Code at `src/core/recall/match-fields.ts` (scoring) and `src/core/recall/recall-service.ts` (orchestration).

Operators who want a comparable measurement on their own corpus can:

1. Curate a query set of 50+ "where did we decide X" questions, each tagged with the session id that answers them
2. Run the same retrieval code (`RecallService.search` with `mode: "keyword"`)
3. Compute R@5 against their tagged ground truth

Tooling for this is on the roadmap (a `nlm eval` subcommand that takes a JSON query file and reports R@k).

## Why keyword scores so high

The scoring function (`src/core/recall/match-fields.ts`) weights matches by field:

| Field | Weight | Why |
|---|---|---|
| Entity exact | ×4 | Strongest signal — "GOAT Home Services" matching a session's entity list almost always means it's relevant |
| Label | ×3 | The classifier-generated label is the densest representation of what the session was about |
| Decision | ×2 | Decisions are the load-bearing markers people search for |
| Open question | ×2 | "Is X still open" queries hit here |
| Summary | ×1 | Catch-all |
| Phrase bonus | +5 | Multi-token match in order gets a bonus |

The classifier produces high-quality labels and entity tags from the session transcript, which is what makes keyword-only retrieval beat what naive substring matching would give. The classifier IS the moat for keyword performance, even though the retrieval algorithm itself doesn't use the classifier at search time.

## Where this number can break

- **Without classifier output**: a fresh install with no classified sessions has nothing for keyword to score against. Body-only fallback works but is closer to grep than to the 97.2% figure.
- **Probe traffic**: test queries inflate the denominator. Both the LongMemEval harness and the digest filter against the `PROBE_PATTERNS` substring list (`src/core/digest/compose.ts`).
- **Single-token short queries**: "yes" or "3" match too liberally. The harness handles these via word-boundary matching; if you're measuring your own corpus, do the same.

## Related code

- `src/core/recall/recall-service.ts` — orchestration
- `src/core/recall/match-fields.ts` — field weights + phrase bonus
- `src/core/recall/query-shape.ts` — query normalization
- `scripts/longmemeval/run-harness.ts` — public benchmark harness
- `scripts/longmemeval/scorer.ts` — R@k and session-body-hit
- `tests/integration/recall-golden.test.ts` — golden-corpus regression test
