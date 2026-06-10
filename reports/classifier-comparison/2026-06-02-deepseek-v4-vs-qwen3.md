# Classifier head-to-head — DeepSeek V4 Flash vs qwen3:4b-instruct-2507

**Date:** 2026-06-02
**Question:** Can a local classifier reasonably replace DeepSeek V4 Flash as the default for nlm-memory?
**Method:** Same 20 Claude Code coding sessions, identical classifier prompt, temperature=0, head-to-head.
**Verdict:** Yes — qwen3:4b is recommended as the local default.

## Setup

- **Corpus:** 20 stratified sessions from the maintainer's `~/.claude/projects/.../<workspace>` archive, ranging from 156 KB to 7.6 MB raw transcripts, truncated to ≤16K characters each before classification (matches the production `MAX_TRANSCRIPT_CHARS` ingest path).
- **Prompt:** The shipped `CLASSIFIER_SYSTEM_PROMPT` from `src/core/classifier/prompt.ts` verbatim. No tuning per model.
- **Parameters:** `temperature=0`, `format=json` (Ollama) / `response_format=json_object` (DeepSeek).
- **Hardware:** Mac (M-series), Ollama 0.24.0 for qwen3.

## Aggregate metrics

| Metric | DeepSeek V4 Flash | qwen3:4b-instruct-2507 |
|---|---|---|
| JSON valid | **20/20** | **20/20** |
| All required keys | **20/20** | **20/20** |
| Median entities | 12.0 | 13.0 |
| Mean entities | 12.2 | 12.9 |
| Median decisions | 3.5 | 3.0 |
| Mean decisions | 3.4 | 3.3 |
| Median open questions | 2.5 | 3.0 |
| Mean open questions | 2.3 | 2.5 |
| Open-question coverage (≥1 per session) | 75% (15/20) | **100% (20/20)** |
| Median label chars | 44 | 38 |
| Avg self-reported confidence | 0.89 | 0.95 |
| **Median latency** | **11.4s** | 39.6s |
| **Cost per 20 sessions** | ~$0.06 (~$0.003/session) | $0 (local, ~3.5 GB RAM) |
| Prompt tokens / 20 sessions | 95,940 | n/a (local) |
| Completion tokens / 20 sessions | 29,235 | n/a (local) |

## Entity-overlap analysis (case-insensitive exact match)

| | Median per session | Mean per session |
|---|---|---|
| Entities both extracted (intersection) | 5.5 | — |
| Entities only DeepSeek extracted | 6.0 | 6.8 |
| Entities only qwen3 extracted | 7.0 | 7.5 |

**Interpretation:** roughly half of each model's entities are unique to that model. The models have different *biases* — not different *quality*. Spot-checks (next section) confirm both surfaces of unique entities are typically legitimate.

## Side-by-side samples (5 of 20)

| Session | Field | DeepSeek V4 Flash | qwen3:4b-instruct-2507 |
|---|---|---|---|
| s01 BOM | label | "Update E-Ink Notes BOM display cost" | "Update E-Ink Notes BOM with JD9851 Quote" |
| | top entities | E-Ink Notes, JD9851, SEEKINK, Good Display, ESP32-C3, Waveshare, LCSC, Mouser | E-Ink Notes, JD9851, SEEKINK, SEEED Studio ODM, ESP32-C3, Waveshare, JLCPCB, FCC |
| | open | 4 (specific JD9851 quote questions) | 1 (consolidated JD9851 quote question) |
| s05 standup | label | "Daily standup with CRM tool errors" | "Daily Standup Report with NocoDB Outage" |
| | top entities | NocoDB, Apple Reminders, Twenty CRM, InvoiceNinja, daily-standup skill, Hermes cron, GraphQL, Cloudflare | NocoDB, Apple Reminders, Twenty CRM, InvoiceNinja, Content Pipeline, [redacted client], [redacted operator] |
| | open | 1 (Twenty CRM error cause) | 3 (Twenty CRM, junction record, pipeline) |
| s10 NLE Memory | label | "Resume NLE Memory TS rewrite planning and documentation" | "NLE Memory TS Rewrite Phase A.2" |
| | top entities | NLE Memory, TypeScript, Python, Qdrant, SQLite, better-sqlite3, sqlite-vec, Hono | NLE Memory, nle-memory-ts, SqliteSessionStore, RecallService, NocoDB, Qdrant, agent_martech, log.md |
| | open | 3 | 3 |
| s15 NLM temporal | label | "NLM temporal reasoning improvement planning" | "NLM Temporal-Reasoning Fix with RRF" |
| | top entities | nlm-memory-ts, LongMemEval-S, Ollama, nomic-bert, RecallService, canonical.sqlite, CHANGELOG, track-record.md | nlm-memory-ts, canonical.sqlite, LongMemEval-S, embedding cache, recall-service, query-shape.ts, RRF, agent-routing |
| | open | 5 | 3 |
| s20 Cronic | label | "Cronic Phase 2.2 documentation and wiki updates" | "Cronic Phase 2.2: Agent Capabilities & Learnings" |
| | top entities | Cronic, cronic.md, Operations/what-failed.md, Operations/what-works/agent-routing.md, Ventures/cronic/learnings.md, DeepSeek V4 Pro, cron-ops agent | Cronic, Cronic Changelog, cronic.md, agent-routing, deepseek, what-failed, what-works, Tool Lessons |
| | open | **0** | **3** (legitimate follow-ups — stuck-record cleaner, n8n API route, telemetry shim) |

## Observed biases

- **DeepSeek leans general/canonical** — picks up "TypeScript", "Python", "Cloudflare", "GraphQL", and canonical file paths.
- **qwen3 leans specific/symbolic** — picks up `SqliteSessionStore`, `RecallService`, `query-shape.ts`, `RRF`.

For nlm-memory's keyword scoring, where entity-exact matches are weighted ×4 and labels ×3, **qwen3's bias toward concrete code symbols probably helps retrieval slightly more** than DeepSeek's bias toward canonical tech-stack names. Directional, not decisive; not measured end-to-end here.

## Failure cases

- **DeepSeek lost on s20 (Cronic):** returned `open: []`. qwen3 found three real follow-ups that any operator looking at that session would want surfaced.
- **No comparable losses for qwen3** were observed in the 5 spot-checked sessions — DeepSeek and qwen3 both returned legitimate content; DeepSeek just sometimes returned an empty `open[]` where qwen3 found follow-ups.

## Recommendation

**Default the local classifier to `qwen3:4b-instruct-2507-q4_K_M`** in the next minor release, replacing `phi4-mini:latest`. Justification:

1. **Statistical tie with DeepSeek on schema validity, entity count, and decision count** on a real coding-session corpus.
2. **Better open-question coverage** (100% vs 75%). Open-question recall is a primary use case for nlm-memory ("what's still open on X").
3. **Same RAM bucket as current phi4-mini default** (3.5 GB vs 2.4 GB), within reach for 8 GB Mac users.
4. **3.5× slower than DeepSeek per session**, but classification is a one-time-per-session cost and is invisible in steady-state operation.
5. **Cost: $0 vs DeepSeek's ~$0.003/session.** For a user ingesting 1,000 sessions, that's $3 vs $0.

DeepSeek (and other cloud providers) remain opt-in via Settings → Providers for users who prioritize speed or already have an API key.

## Caveats

1. **N=20.** Directional finding is robust; specific numbers are point estimates.
2. **Single-corpus (Claude Code coding sessions).** Other session types (customer-support transcripts, research-paper conversations, personal-life chat) may differ — LongMemEval-S already demonstrated qwen3 has a 33% schema-failure rate on personal-life conversation, where the prompt expects coding-session structure that isn't present.
3. **Classifier output quality only, not end-to-end R@5.** This compares the inputs into the retriever, not retrieval scores. The bench harness (in progress) will close that loop.
4. **Open-question coverage advantage for qwen3 could be either better extraction or over-extraction.** Spot-checks of qwen3's open questions on 5 sessions found them all legitimate, but a larger sample with adversarial review is needed before claiming "qwen3 finds more open questions" as a strict win.

## Reproducing this

Inputs and outputs are not committed (sessions contain personal data). The methodology is reproducible:

1. Pick 20 stratified sessions from `~/.claude/projects/**/*.jsonl`
2. Extract transcripts using the same logic as `src/core/adapters/claude-code.ts`
3. POST each transcript to:
   - Ollama: `localhost:11434/api/chat` with `model=qwen3:4b-instruct-2507-q4_K_M`, `format=json`, the shipped `CLASSIFIER_SYSTEM_PROMPT`
   - DeepSeek: `api.deepseek.com/v1/chat/completions` with `model=deepseek-v4-flash`, `response_format=json_object`, same prompt
4. Aggregate against the same dimensions in the table above.

The runner scripts used (`/tmp/nlm-batch-run.mjs`, `/tmp/nlm-classify-deepseek.mjs`) are intentionally not committed — they were one-shot tools for this comparison, not maintained code. The reusable harness for ongoing classifier comparisons lives at [scripts/longmemeval/run-harness.ts](../../scripts/longmemeval/run-harness.ts) (`--classifier <provider>:<model>` flag).
