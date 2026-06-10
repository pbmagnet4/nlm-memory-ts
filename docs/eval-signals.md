# Evaluating the agent self-improvement signals lane

Two layers of evaluation: a deterministic synthetic eval that proves the
pipeline is correct and non-noisy today, and a real-data measurement plan for
proving the loop is *meaningful* once live signals accumulate.

## 1. Synthetic meaningfulness eval (now)

`npm run eval:signals` (`scripts/eval/signals-eval.ts`) drives the real pipeline
end to end - `normalizeSignal` -> `SqliteSignalStore` -> `aggregateFailureModes`
-> `buildFailureModeBlock` -> `recommendActions` - against a deterministic
440-signal corpus across 3 repos and 2 models, and checks the outputs are
correct, useful, and quiet when they should be. It exits non-zero on any failure
and prints the rendered failure-mode block so a human can read a real result.

Criteria checked:

1. **Correctness + recall.** A model that fails `tsc` ~38% over 120 events in a
   repo surfaces as a failure mode with the right step, rate, and sample size.
2. **Precision (no nagging).** A strong model in the same repo, a sub-threshold
   repo (8% fail rate), and sub-floor steps (10%, below the 20% rate gate) all
   produce an empty block. The block is earned, not constant.
3. **Scoping / isolation.** Recall is scoped to (repo, model); a different
   `install_scope` sees nothing.
4. **Recommendations are proportionate.** A 62% repo earns a model-swap
   suggestion; a 38% step earns an AGENTS.md-rule suggestion but no swap (under
   the 50% swap threshold). Surface + recommend only - nothing auto-acts.
5. **Ranking + cap.** Worst failure rate ranks first; `maxModes` is respected.
6. **Idempotency.** Re-ingesting the full corpus changes nothing (deterministic
   id + `INSERT OR IGNORE`).

This proves the logic. It does **not** prove the loop changes agent behavior in
the wild - that needs real data.

## 2. Real-data measurement plan (once Pi sessions accumulate)

The producer is the Pi `quality-gate` extension (in the `pi-sandbox` repo). Once
it has emitted `nlm.signal` events across real coding sessions for a few weeks,
measure four things, in priority order.

### a. Coverage (is there enough signal?)
- Signals per day, and number of distinct `(repo, model, step)` buckets that
  reach `n >= 10` in the trailing 14d window. Below that, nothing surfaces.
- Source: `nlm improve --days 30` and `GET /api/signals/stats?days=30`.
- Healthy: at least a handful of buckets crossing `n >= 10` for the models you
  actually run. If coverage is thin, lengthen the window
  (`buildFailureModeBlock` `windowDays`) or lower `minSamples`.

### b. Precision of surfaced modes (are they real?)
- For each surfaced failure mode, spot-check it against the actual gate behavior:
  is `qwen3-coder` genuinely weak at `tsc` in that repo? Compare a sample of the
  underlying signals' `detail` against the raw `quality-gate` outcomes.
- Healthy: surfaced modes correspond to failures a human would also call
  recurring. False positives mean the rate/sample thresholds are too loose.

### c. Loop closure (does recall reduce repeat failures?) - the real ROI
- This is the metric that justifies the feature. When a failure mode starts
  surfacing for `(repo, model, step)`, the agent gets the block at session start.
  Measure the step's fail rate in the **N sessions after** the block began
  injecting vs the N sessions before.
- A meaningful loop shows a downward shift (the agent self-corrects on the warned
  step). A flat line means the injected block is not changing behavior - revisit
  the wording of `renderFailureMode`, or whether the block is actually reaching
  the model (check the Pi consumer extension is loaded and `NLM_HOOK_MODE`).
- Practical proxy until a controlled before/after exists: track the trailing
  fail rate per surfaced bucket over time and watch whether surfaced buckets
  trend down faster than unsurfaced ones.

### d. Noise / operator trust
- How often is a block injected? If it fires on nearly every session, the
  threshold is too low and operators will tune it out. If it never fires despite
  real failures, it is too high.
- Track operator actions taken from `nlm improve` (did a model get swapped, did
  an AGENTS.md rule get added?). Recommendations nobody acts on are a signal the
  output is not actionable enough.

### Tuning levers
- Rate / sample floors: `aggregateFailureModes({ minFailRate, minSamples })`
  (defaults 0.2 / 10).
- Window: `buildFailureModeBlock({ windowDays })` (default 14).
- Cap: `maxModes` (default 3).
- Swap threshold: `recommendActions({ swapThreshold })` (default 0.5).
- Kill switch: `NLM_SIGNALS_ENABLED=0` disables both ingest transports.
- Retention: `NLM_SIGNAL_RETENTION_DAYS` (default 90).

### Cadence
Re-run the coverage + precision check monthly (it is cheap). Run the loop-closure
measurement once a bucket has enough before/after sessions to compare - this is
the one that tells you whether the feature is worth keeping.
