# Stranger-recovery simulation — 2026-06-10

First run of the install-and-recover validation (NLM task #300). Two phases: a timed
cold install following only the README, then a context-free agent ("the stranger")
answering a reasoning-recovery question using only the product's surfaces. The stranger
had no access to the source tree and no knowledge of NLM internals.

**Harness:** sandbox at `/tmp/nlm-stranger` (isolated HOME, npm prefix, `NLM_PORT=3941`);
install from GitHub HEAD (`b90b816` era); corpus = 5 synthetic sessions forming a
vector-database decision arc with one operator supersedence (s5 supersedes s2, seeded
via the real CLI/action surface). Production daemon on 3940 verified untouched
throughout.

## Headline results

| Measure | Result |
|---|---|
| Install (after workarounds) | ~13s npm work; ~4 min wall incl. failure diagnosis |
| Recovery question | "Why pgvector over Qdrant, and was anything reconsidered?" |
| Time to confident answer | ~5–6 minutes from first README read |
| Answer correctness | Full arc recovered: decision + rationale + revisit triggers + both reconsiderations; current-vs-historical state stated correctly |
| Supersedence read | Correctly identified s2 as superseded by s5, via prose hint in recall + structured `supersedes`/`supersededBy` fields |
| Verdict | "I'd keep it installed… the tool told me the original decision was superseded rather than letting me confidently repeat stale reasoning, which is exactly the failure mode a memory layer exists to prevent." |

The 90-day success criterion "a stranger can install and recover one real piece of
reasoning" is **met**, with the caveat list below.

## Release-blocking find (fixed same day)

**`migrations/` was never in the npm `files` array.** `runMigrations` scandirs
`<package-root>/migrations` in the storage constructor, so every storage-touching
command on a fresh npm install of any published version crashed with ENOENT.
Reproduced on a pristine install of `nlm-memory@0.9.2`; fixed in `b90b816`. Every
published version prior to the next release is dead-on-arrival for new installs —
ship the next release promptly.

## The product-shaping finding: superseded sessions are invisible exactly when they matter

The single most on-point session for the question — the decision session s2 — never
appeared in `nlm recall` output, because recall excludes superseded sessions (by
design, and correctly, for agent prompt-injection). The stranger found it only by
chasing a `supersedes` pointer from s5's full body. Recall list output carries no
supersedence badge or chain metadata, so a user who trusts the recall list alone gets
a subtly wrong current-state answer.

Design tension to resolve (tracked as #303): injection recall and investigative recall
want different supersedence behavior. Candidate directions: badge superseded hits and
include them down-ranked in investigative surfaces; or promote the superseder when a
superseded session matches strongly ("a matching session was overturned by this one").

## Friction list (tracked: #303 recall surfacing, #304 CLI/API ergonomics, #305 README)

1. Superseded decision invisible in recall; no supersedence badge in recall snippets (#303)
2. No `nlm config get` / `nlm token`; bearer token only via reading the dotfile (#304)
3. No REST endpoint to write a citation (MCP-only); `cite-stats` is read-only (#304)
4. README hardcodes `localhost:3940` in every example; wrong under `NLM_PORT` (#305)
5. `/api/recall/facts` returns `total:0` silently before `backfill-facts`; reads as a bug (#305)
6. README leads with the interactive `nlm setup` wizard; non-interactive path undocumented (#305)
7. CLI gives no hint that `--mode hybrid` exists; recall defaults to keyword (#304)
8. (Phase 1) `npm install -g github:` fails under a stripped PATH via better-sqlite3's
   prebuild-install spawn; `npm pack` + install-from-tgz works (env-specific; noted, not tasked)

## Re-run notes

The harness is reusable as a release gate: rebuild the sandbox (phase-1 prompt in the
orchestrator session of 2026-06-10), point the install at the release tag, re-ask the
same question. Keep the corpus seeded with at least one operator supersedence — the
production corpus contained none until this exercise, and the overturn-read is the
heart of what the test validates.
