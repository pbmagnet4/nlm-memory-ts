# Classifier Extraction-Quality Eval

Scores the **truth** of what a classifier extracts — are its decisions and
entities faithful to the transcript, and does it recover the decisions a strong
reference model found? This is the first eval in the repo that measures
extraction quality rather than structure (JSON validity, counts). Extraction
quality is upstream of every recall and precision number the daemon reports, so
it gets its own measurable score.

Harness: `scripts/eval/classifier-eval.ts` (run via `npm run eval:classifier`).
Pure scoring: `scripts/eval/extraction-scoring.ts`. Judge transport +
verdict cache: `scripts/eval/judge.ts`.

## What it measures

Per candidate classifier config, three macro-averaged surfaces:

- **Decision precision** — of the decisions a candidate extracted, what fraction
  a judge rules `supported` against the **transcript** (not the reference). A
  candidate may legitimately surface a true decision the reference missed, so
  precision is judged against ground truth, not against the reference.
- **Decision recall** — of the **reference** decisions, what fraction the judge
  rules semantically matched by some candidate decision.
- **Entity precision** — of the entities a candidate extracted, what fraction
  the judge rules actually present and relevant in the transcript.

Plus **schema-failure rate** (sessions where the candidate produced no usable
`ClassifyResult`) and **mean latency per session**.

A surface with zero items on a session yields `null`, not `0` — a session with
no extracted decisions has undefined precision, not 0%, and is dropped from the
mean rather than dragging it down.

## Gold set + references (not in the repo)

The eval reads two files from `$NLM_EVAL_DATA_DIR` (default `/tmp/nlm-309`):

- `gold-bodies.json` — `[{ id, runtime, cited, body }]`. Bodies are capped at
  20,000 chars. **Transcripts stay in `/tmp` by design** — only aggregate
  scores and session ids reach the committed report.
- `reference.json` — `[{ id, decisions[], open[], entities[] }]`. The reference
  extraction produced by a strong model (one author per run; treat as a single
  high-quality opinion, not ground truth).

Privacy contract: per-session transcripts and per-session extractions never
leave the data dir. The committed report carries aggregates + session ids only.

To rebuild the gold set, copy the production DB **read-only** and select
sessions weighted toward cited ones (`cited_id` in `~/.nlm/citation-log.jsonl`)
with random diversity fill across runtime and length buckets. Never write to
`~/.nlm` and never restart the daemon — it is live.

## Running

```bash
NLM_EVAL_DATA_DIR=/tmp/nlm-309 \
NLM_OLLAMA_URL=http://localhost:11434 \
NLM_EVAL_JUDGE_MODEL=Qwen3.5-122B-A10B-mlx-nvfp4 \
npm run eval:classifier
```

Output: `$NLM_EVAL_DATA_DIR/eval-results.json` (working artifact, stays in
`/tmp`) plus a markdown table printed to stdout. Copy the table + caveats into a
dated report under `reports/classifier-eval/`.

### Env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `NLM_EVAL_DATA_DIR` | `/tmp/nlm-309` | Gold set + references + per-run cache |
| `NLM_EVAL_CACHE_DIR` | `$DATA_DIR/cache` | Classifier + judge SQLite caches |
| `NLM_OLLAMA_URL` | `http://localhost:11434` | Prod-candidate Ollama endpoint |
| `NLM_CLASSIFIER_MODEL` | `qwen3:4b-instruct-2507-q4_K_M` | Prod-candidate model (matches the live daemon default) |
| `NLM_EVAL_JUDGE_MODEL` | `Qwen3.5-122B-A10B-5bit` | Judge model on the Studio |

### Caching

Both the classifier and the judge cache to disk keyed by content hash
(`scripts/longmemeval/classifier-cache.ts` and `JudgeCache` in `judge.ts`).
Re-runs are cheap: only new (model, body) pairs and new judge prompts execute.
The judge parses a reply **before** caching it, so a malformed verdict is never
persisted — a re-run retries it cleanly.

## Adding a candidate

Edit `buildCandidates()` in `classifier-eval.ts`. Each candidate is
`{ key, label, client }` where `client` implements `ClassifierClient`
(`classify(transcript): Promise<ClassifyResult>`):

- **Ollama / DeepSeek (production lanes):** reuse `OllamaClient` /
  `DeepSeekClient` from `src/llm/`.
- **Any OpenAI-compatible endpoint (Studio auditions):** use the eval-local
  `OpenAICompatibleClassifier` already in the harness. It reuses the shared
  prompt + coercer; only the transport differs.

`key` is `"<provider>:<model>"` — the cache namespaces on it, so two candidates
with the same key share a cache. Keep keys distinct per model.

## Sequencing on the Mac Studio (oMLX)

The Studio serves **one big model at a time** and does not auto-evict. The
harness runs **all candidate-A classifications, then all candidate-B, then all
judge calls** so each model loads once instead of thrashing. Two hard-won
constraints:

- **Judge must stream.** oMLX returns an empty 200 on a non-streaming
  mid-generation error and surfaces errors *inside* the SSE stream. `judge.ts`
  always requests `stream: true` and treats an empty assembled body as failure.
- **Judge memory ceiling.** The judge embeds the transcript once per
  decision/entity precision check. The full 20K body overflowed the
  `122B-A10B-5bit` prefill memory cap; the harness caps the judge-embedded
  transcript at 12K (head + tail) and the run uses the lower-footprint
  `122B-A10B-mlx-nvfp4` quant of the same model. If the 5bit quant is resident
  alongside a prior audition model, it will fail to load with a
  `Prefill context too large` error at `kv_len=0` — prefer the nvfp4 quant or
  ensure the prior model is evicted first.

## Limitations

- Single reference author per run — the reference is one strong opinion, not
  consensus ground truth.
- Single judge model — judge bias is not cross-checked.
- N is small (~30) — treat surface deltas under a few points as noise.
- Judge abstentions (verdicts unparseable after retry) degrade to a
  conservative verdict and are reported in `judge_abstentions`; a high count
  undermines the run.
