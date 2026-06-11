# Classifier Extraction-Quality Eval — 2026-06-11

First run of the extraction-quality harness (`npm run eval:classifier`,
`scripts/eval/classifier-eval.ts`). Scores extraction TRUTH (decision/entity
faithfulness) rather than structure. Methodology details and re-run
instructions: `docs/eval-classifier.md`.

## Candidates

| | Provider / model | Endpoint |
| --- | --- | --- |
| Production | `ollama` / `qwen3:4b-instruct-2507-q4_K_M` | `http://localhost:11434` |
| Audition | `Qwen3.5-9B-MLX-8bit` | Mac Studio oMLX, OpenAI-compatible |

The production candidate was confirmed against the **live daemon**
(`GET /api/classifier/info` → `{"provider":"ollama","model":"qwen3:4b-instruct-2507-q4_K_M"}`).
Note: `~/.nlm/config.toml` carries a stale `[classifier] provider = "deepseek"`
block that the runtime ignores — `buildClassifier()` resolves from
`NLM_CLASSIFIER`/`NLM_CLASSIFIER_MODEL` env (unset → Ollama default).

Judge: `Qwen3.5-122B-A10B-mlx-nvfp4` on the Studio, streaming, JSON-only
verdicts, content-hash cached.

## Gold set

30 production sessions (ids in `/tmp/nlm-309/gold-manifest.json`; transcripts
never leave `/tmp`):

- **Cited weighting:** 22 of 23 distinct `cited_id`s from
  `~/.nlm/citation-log.jsonl` (one had no usable body in the DB), plus 8
  random fill stratified across runtime × length bucket.
- **Runtimes:** claude-code 23, pi 5, hermes 2.
- **Lengths:** 21 long (≥9K chars), 4 medium, 5 short; bodies capped at
  20,000 chars; mean 14,281.
- **Reference:** one strong-model author produced `decisions[]/open[]/entities[]`
  per session (single opinion, not consensus ground truth).

## Results

```
| Candidate | Decision P | Decision R | Entity P | Schema fail | Latency/session |
| --- | --- | --- | --- | --- | --- |
| prod ollama qwen3:4b-instruct-2507-q4_K_M | 28.6% (n=7) | 50.0% (n=2) | 97.8% (n=9) | 70.0% | 5538ms |
| audition Qwen3.5-9B-MLX-8bit | 86.2% (n=19) | 9.8% (n=15) | 96.9% (n=30) | 0.0% | 15622ms |
```

(n = sessions contributing to each macro-averaged surface. Judge:
456 verdicts, 37 cache hits, 9 abstentions (~2%) degraded to conservative
verdicts. Full JSON: `/tmp/nlm-309/eval-results.json`.)

## Finding 1 — production schema-failure root cause (the headline)

The production candidate failed **21 of 30 sessions (70%)**. Failures are
perfectly length-correlated: every session ≥12,314 chars failed; every session
≤8,575 chars succeeded. Failures are fast (104–335 ms), not timeouts.

Root cause, reproduced directly against the local Ollama: the server runs
qwen3:4b with a **4096-token context window** and returns HTTP 400
`exceed_context_size_error` (`request (4535 tokens) exceeds the available
context size (4096 tokens)`) for the classifier prompt at its own 15K-char
truncation. `OllamaClient.classify` does not set `num_ctx`, so the server
default applies and the daemon's `LLMUnreachableError` path swallows the
specifics.

Implication: the production classifier lane currently cannot extract anything
from long sessions — which are exactly the sessions most worth remembering
(70% of this cited-weighted gold set). Fix candidates (not applied — recommend
only): set `options.num_ctx` (≥8192) in `OllamaClient`, or lower the transcript
cap for the Ollama lane. This is the dominant quality lever; it dwarfs any
model-choice question.

## Finding 2 — audition quality

Qwen3.5-9B-MLX-8bit classified **all 30 sessions** with zero schema failures.

- **Decision precision 86.2%** — judged against the transcript, most of its
  extracted decisions are real commitments.
- **Entity precision 96.9%** across all 30 sessions (prod: 97.8% but on only
  9 scorable sessions — entity extraction is easy mode for both).
- **Latency 15.6 s/session** on the Studio. Prod's 5.5 s mean is flattered by
  fast failures; its successful classifications ran 5.8–30.2 s, so true
  throughput is comparable.

## Finding 3 — decision recall numbers are not trustworthy this run

- Prod recall (50%) rests on **n=2** sessions — noise.
- Audition recall (9.8%) is confounded by reference positional bias: long-session
  references were authored primarily from each session's opening arc, while the
  classifier (seeing head+tail of the truncated body) tends to extract
  closing-arc commitments — the operative end-state decisions. Spot check
  (`cc_5f0f70dd`): the audition's decisions were supported closing-arc
  commitments that the opening-biased reference did not contain. Both
  candidates were judged against the same reference, so the head-to-head is
  fair, but the absolute recall numbers underestimate true recall and should
  not be quoted standalone.

## Judge reliability observations

- The specified judge (`Qwen3.5-122B-A10B-5bit`) **could not load** — oMLX
  reported `Prefill context too large ... kv_len=0` even on tiny prompts while
  the 9B audition model was resident (no auto-eviction). The run used the
  lower-footprint `Qwen3.5-122B-A10B-mlx-nvfp4` quant of the same model.
- The judge-embedded transcript had to be capped at 12K chars (head+tail) to
  stay inside the prefill memory ceiling.
- The nvfp4 judge occasionally emits malformed JSON verdicts: 9 abstentions
  out of 456 (~2%), each degraded to a conservative verdict
  (unsupported/unmatched). The harness now parses before caching, so malformed
  replies are retried rather than poisoning the cache.
- oMLX confirmed returning errors inside the SSE stream (and empty 200s
  non-streaming) — `stream: true` is mandatory, as the harness assumes.

## Verdict + recommendation (recommend only — no production change made)

1. **Fix the production lane before re-auditioning models.** The 70%
   schema-failure rate is an Ollama `num_ctx` configuration bug, not a model
   quality result. Until it's fixed, prod extraction quality on long sessions
   is zero and any model comparison is moot.
2. **Qwen3.5-9B-MLX-8bit passes the audition** on reliability (0% schema
   failure) and decision precision (86.2%). It is a credible classifier
   candidate *if* a Studio-backed lane is acceptable — the daemon currently has
   no Studio provider row, and the Studio is a shared single-resident-model
   host, so co-residency with other workloads needs thought.
3. **Recommended sequence:** patch `num_ctx` for the Ollama lane → re-run this
   eval (caches make it cheap) → compare a fixed qwen3:4b against the 9B on
   equal footing before any default change.

## Limitations

- N=30; surface deltas under a few points are noise.
- Single judge model, single quant, no cross-judge agreement check.
- Single-author reference with positional bias on long sessions (see Finding 3).
- 9 judge abstentions resolved conservatively (slightly deflates precision and
  recall for the candidate being judged, mostly the audition).
- Recall sample for prod is n=2 — uninterpretable.
