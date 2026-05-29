<p align="center">
  <strong>nlm-memory</strong><br/>
  Local-first non-linear memory OS for AI operators
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/nlm-memory"><img src="https://img.shields.io/npm/v/nlm-memory?color=CB3837&label=npm&logo=npm" alt="npm version" /></a>
  <a href="https://github.com/pbmagnet4/nlm-memory-ts/blob/main/LICENSE"><img src="https://img.shields.io/github/license/pbmagnet4/nlm-memory-ts?color=blue" alt="License: Apache 2.0" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/nlm-memory?color=brightgreen" alt="Node 20+" /></a>
  <img src="https://img.shields.io/badge/tests-612%20passing-success" alt="612 tests passing" />
  <img src="https://img.shields.io/badge/runtimes-9-8A2BE2" alt="9 runtimes supported" />
  <img src="https://img.shields.io/badge/telemetry-none-informational" alt="Zero telemetry" />
</p>

<p align="center">
  <a href="#install">Install</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#runtimes">Runtimes</a> &middot;
  <a href="#how-recall-works">How recall works</a> &middot;
  <a href="#mcp-tools">MCP</a> &middot;
  <a href="#rest-api">REST API</a> &middot;
  <a href="#daily-digest">Digest</a> &middot;
  <a href="#configuration">Config</a> &middot;
  <a href="#security">Security</a> &middot;
  <a href="#vs-alternatives">vs Alternatives</a>
</p>

---

`nlm-memory` indexes every session from Claude Code, Codex, OpenCode, Cursor, Windsurf, Hermes, Aider, and pi into a single searchable store on your machine. Three properties no other memory layer ships together:

1. **Cross-runtime reach.** One index, every adapter.
2. **Editable timeline.** Sessions can be superseded, retired, or marked aborted. Patch history retroactively — no other tool lets you do this.
3. **97.2% R@5 baseline.** On a 14-month corpus, keyword recall surfaces the right session in the top 5 on 97.2% of evaluator queries. No fine-tuning, no cloud, no account.

Everything stays on your machine. No telemetry, no account beyond your classifier of choice.

---

## Install

```sh
npm install -g nlm-memory
nlm setup
```

`nlm setup` is the interactive first-run wizard. It picks your classifier + model, wires the runtimes you actually use, generates an `NLM_MCP_TOKEN`, hardens permissions on `~/.nlm/`, and installs the daemon supervisor for your platform.

| Platform | Daemon | Notes |
|---|---|---|
| **macOS** | LaunchAgent at `~/Library/LaunchAgents/com.github.pbmagnet4.nlm-memory.plist` | Auto-starts on login |
| **Linux** | systemd user unit at `~/.config/systemd/user/nlm.service` | Headless servers: `loginctl enable-linger $USER` so the daemon survives logout |
| **Windows** | Manual `nlm start` for now | Hook + MCP install paths are platform-aware; supervisor lands next release |

Stop or remove: `nlm uninstall`.

---

## Quick Start

After `nlm setup` finishes, open **http://localhost:3940/ui** — the daemon is running. A 30-second sanity check:

```sh
nlm recall "what was that pgvector decision"   # one-shot search from the shell
nlm digest                                      # yesterday's activity at a glance
nlm --version
```

---

## Runtimes

One corpus across every adapter. `nlm connect` wires hooks + MCP for each runtime:

| Runtime | Connect | Sessions read from | Hooks |
|---|---|---|---|
| **Claude Code** | `nlm connect claude-code` | `~/.claude/projects/**/*.jsonl` | 5 (UserPromptSubmit, SessionStart, Stop, PreCompact, SubagentStart) |
| **Codex CLI** | `nlm connect codex` | `~/.codex/sessions/` | Marketplace plugin |
| **Hermes** | `nlm connect hermes` | Hermes session DB | MCP only |
| **Hermes Agent** | `nlm connect hermes-agent` | Hermes plugin path | pre-turn, post-turn, lifecycle |
| **Cursor** | `nlm connect cursor` | Cursor IDE chat DB | MCP only |
| **Windsurf** | `nlm connect windsurf` | Windsurf user dir | MCP only |
| **OpenCode** | adapter active | `~/.local/share/opencode/` | MCP only |
| **Aider** | adapter active | `AIDER_CHAT_HISTORY_FILE` | MCP only |
| **pi.dev** | adapter active | `~/.pi/sessions/` | MCP only |

`nlm disconnect <runtime>` reverses any of the above.

---

## How recall works

Two delivery paths. They share the same index.

### 1. Hooks (Claude Code) — automatic context injection

Five hooks installed into `~/.claude/settings.json`:

| Event | What NLM does | Mode |
|---|---|---|
| **UserPromptSubmit** | Score the prompt, silently prepend pointer block listing 0–3 most likely-relevant prior sessions | live by default |
| **SessionStart** | Cold-start agents (cron, background) hit this; same pointer-block delivery without a user prompt | live by default |
| **Stop** | Scan the model's response for citations of surfaced session IDs → updates `useful_hit_rate` and builds the reranker training substrate | always on |
| **PreCompact** | Flush the per-conversation surfaced-IDs memo so post-compaction recalls aren't gated | always on |
| **SubagentStart** | Record parent→subagent links so threads stay coherent across dispatches | always on |

Switch to **shadow** mode (log-only, no injection) anytime with `NLM_HOOK_MODE=shadow` on the hook command. Toggle for an existing install: re-run `nlm hook install` after changing the env var. The hook fails open — any error yields a clean exit and never blocks the model.

### 2. MCP — explicit tools any agent can call

Container-hosted agents (Hermes WebUI, Codex CLI, etc.) hit the Streamable-HTTP `POST /mcp` endpoint with `Authorization: Bearer ${NLM_MCP_TOKEN}`. Stdio MCP is also supported for Claude Code via `~/.mcp.json`.

---

## MCP Tools

| Tool | What it does |
|---|---|
| `recall_sessions` | Hybrid keyword+semantic search across the full session corpus. Returns label, started_at, snippet, match score. |
| `get_session` | Full body of one session by ID. Includes enriched `supersedes` / `supersededBy` links (id + label + summary) so chasing corrected facts doesn't need a second round-trip. |
| `recall_facts` | Search structured facts: decisions, open questions, project state. Filterable by entity and kind. |
| `get_fact_history` | Full version history of one fact — how a decision evolved over time. |
| `cite_session` | Mark a session as explicitly referenced. Drives the `useful_hit_rate` metric and the future learned reranker. |

---

## REST API

Daemon binds `127.0.0.1:3940` (override with `NLM_PORT`). Selected endpoints:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | Host-only | Liveness probe; returns `{version, status, service}` |
| GET | `/api/recall` | Bearer/Origin | Hybrid recall — `?q=`, `?mode=keyword\|semantic\|hybrid`, `?limit=` |
| GET | `/api/recall/stats` | Bearer/Origin | 7-day stats: total, hit_rate, useful_hit_rate, top queries |
| GET | `/api/recall/recent` | Bearer/Origin | Last N recall events for live tail/telemetry |
| GET | `/api/recall/cite-stats` | Bearer/Origin | Citation rate over `?days=` |
| GET | `/api/session/:id` | Bearer/Origin | Full session body + supersedence links |
| GET | `/api/recall/facts` | Bearer/Origin | Structured fact search |
| GET | `/api/facts/history` | Bearer/Origin | Version chain for one fact |
| GET | `/api/dataset` | Bearer/Origin | Full session list for the UI dataset view |
| GET | `/api/live/recent-writes` | Bearer/Origin | Live tail of ingested sessions |
| GET | `/api/data/backup` | Bearer/Origin | Streaming SQLite snapshot download |
| POST | `/api/data/restore` | Bearer/Origin | Stage a snapshot for apply-on-restart |
| POST | `/api/hook/pre-compact` | Bearer/Origin | Hook endpoint; flushes the surfaced-IDs memo |
| ALL | `/mcp` | Bearer required | Streamable-HTTP MCP transport for container agents |

`/api/*` is gated by three layers: 127.0.0.1 Host check (defeats DNS rebinding), Origin check when the browser sends one (defeats cross-origin drive-by), Bearer fallback when Origin is absent (server-to-server clients).

---

## Daily digest

Once-a-day summary of yesterday's activity:

```sh
nlm digest                  # print to stdout
nlm digest --telegram       # post to Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
```

Reports 24h real-traffic (probes filtered), 7d hit_rate + useful_hit_rate, top 5 queries, and a **`WARN hook silent`** alert when Claude Code ran yesterday but no live hook fires were logged. That alert is the canary for post-install drift — node upgrades, `settings.json` hand-edits, and `dist/` moves silently break the hook while Claude Code keeps working. Setup-time smoke tests can't catch this; only the daily correlation can.

Wire to cron for a morning push:

```cron
0 7 * * *  nlm digest --telegram >> ~/.nlm/logs/digest.log 2>&1
```

When the daemon is unreachable, `--telegram` still fires — posts a "daemon unreachable" alert instead of failing silently.

---

## What's inside the UI

Open `http://localhost:3940/ui` after the daemon starts.

| Page | What it shows |
|---|---|
| **Live** | Sessions being written in real time, recent reads, recent decisions |
| **Pulse** | System health — coherence, runtimes, stale entities, recent sessions |
| **River** | Full session timeline with density controls + superseded-lane visualization |
| **Thread** | Per-entity conversation history with runtime filters and ←/→ navigation |
| **Search** | Keyword, semantic, or hybrid recall with match snippets and field-origin tags |
| **Recall** | Adoption telemetry — useful_hit_rate, source breakdown, query log |
| **Settings** | Sources, providers, classifier, data backup/restore |

---

## Pipeline

What happens when an AI runtime writes a session and you later recall it:

```
ingest:  runtime transcript (jsonl/sqlite)
   -> adapter parses runtime-specific format
   -> classifier (DeepSeek cloud or Ollama local) extracts label + entities + decisions + open questions
   -> embedder (nomic-embed-text via Ollama) computes 768-dim vector
   -> SQLite canonical store + FTS5 keyword index + sqlite-vec ANN index

recall: prompt / query
   -> tokenize + match scoring (label x3, entity-exact x4, decision x2, summary x1, phrase-bonus +5)
   -> hybrid: BM25-style keyword + vector cosine, fused by score
   -> select-top-N gate (per-fire cap 3, per-conversation cap 10)
   -> pointer block prepended to model context (hooks) or returned as tool result (MCP)
```

---

## Configuration

### Environment variables

| Var | Default | What |
|---|---|---|
| `NLM_PORT` | `3940` | Daemon bind port (loopback only) |
| `NLM_DB_PATH` | `~/.nlm/canonical.sqlite` | SQLite canonical store location |
| `NLM_HOOK_MODE` | `live` | `live` injects pointer block; `shadow` logs without injecting |
| `NLM_HOOK_LOG` | `~/.nlm/hook-log.jsonl` | Hook fire log; powers digest's liveness alert |
| `NLM_USEFUL_HIT_LOG` | `~/.nlm/useful-hit-log.jsonl` | Citation/useful-hit ledger |
| `NLM_QUERY_LOG` | `~/.nlm/query-log.jsonl` | Recall query telemetry |
| `NLM_CITATION_LOG` | `~/.nlm/citation-log.jsonl` | Stop-hook citation events |
| `NLM_MCP_TOKEN` | auto-generated | 256-bit bearer for `/api/*` (non-browser) and `/mcp` |
| `NLM_MCP_CONFIG` | `~/.mcp.json` | Path the `connect`/`disconnect` commands modify |
| `NLM_CLASSIFIER` | `deepseek` | `deepseek` (cloud) or `ollama` (local) |
| `NLM_CLASSIFIER_MODEL` | `deepseek-v4-flash` | Model id for the chosen provider |
| `NLM_OLLAMA_URL` | `http://localhost:11434` | Override Ollama endpoint |
| `NLM_ADAPTERS` | all | Comma-separated allowlist of adapters to enable |
| `DEEPSEEK_API_KEY` | — | Required when classifier=deepseek |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Required for `nlm digest --telegram` |

Adapter source paths can be overridden individually: `NLM_CLAUDE_PROJECTS_PATH`, `NLM_CODEX_CONFIG`, `NLM_CURSOR_DB_PATH`, `NLM_HERMES_SESSIONS_PATH`, `NLM_HERMES_AGENT_DB_PATH`, `NLM_WINDSURF_USER_DIR`, `OPENCODE_DB_PATH`, `PI_SESSIONS_PATH`, `AIDER_CHAT_HISTORY_FILE`.

### Config file

`~/.nlm/.env` — autoloaded by every CLI command. Mode `0600`, owned by you, never readable by other users. The setup wizard writes the initial keys; you can edit it directly.

### Ports

| Port | Process | Bind | Override |
|---|---|---|---|
| `3940` | Daemon HTTP API + MCP | `127.0.0.1` only | `NLM_PORT` |
| `11434` | Ollama (embedding + local classifier) | localhost | `NLM_OLLAMA_URL` |

---

## Security

NLM is local-first by design. The daemon:

- Binds to `127.0.0.1` only — never `0.0.0.0`
- Enforces Host + Origin checks on `/api/*` to defeat DNS rebinding and cross-origin drive-by
- Generates a 256-bit `NLM_MCP_TOKEN` on first run, persists to `~/.nlm/.env` (mode `0600`); non-browser clients authenticate with `Authorization: Bearer ${NLM_MCP_TOKEN}` compared with `timingSafeEqual`
- Recursively enforces `0700` on `~/.nlm/` and `0600` on its contents on every start
- Sends nothing outbound except:
  - Ollama (`localhost:11434`) for embeddings and the local classifier path
  - DeepSeek API (`api.deepseek.com`) when classifier is set to DeepSeek
  - Telegram API (`api.telegram.org`) when `nlm digest --telegram` is invoked
  - Your AI runtime transcript files (read-only)

No telemetry. No vendor pings. No account.

Report vulnerabilities via [SECURITY.md](SECURITY.md).

---

## Upgrading from v0.4.x

```sh
npm update -g nlm-memory
```

Old installs have `NLM_HOOK_MODE=shadow` hardcoded in `~/.claude/settings.json` — shadow mode is silent, so re-run `nlm hook install` to switch to live recall injection. Permissions and `NLM_MCP_TOKEN` self-heal on the next `nlm start`.

---

## vs Alternatives

| | **nlm-memory** | mem0 | Letta / MemGPT | Built-in (`CLAUDE.md`) |
|---|---|---|---|---|
| **Unit of memory** | Whole session + extracted markers | Atomic facts | Graph nodes + edges | Static file |
| **Cross-runtime** | 9 adapters, one corpus | Per-app SDK integration | Per-app SDK integration | Per-runtime config |
| **Editable timeline** | Sessions can be superseded, retired, aborted | Append-only fact log | Graph edits | Manual file edits |
| **R@5 baseline** | 97.2% on 14mo corpus | published varies | published varies | n/a |
| **External deps** | SQLite + Ollama (local) | Postgres or Qdrant | Postgres | none |
| **Hosted offering** | none — local only | yes | yes | n/a |
| **Account required** | none | yes (cloud tier) | yes | none |
| **Telemetry** | none | yes | yes | none |
| **License** | Apache 2.0 | Apache 2.0 | Apache 2.0 | — |

The defining property is the editable timeline. mem0 and Letta append; NLM lets you reach back and mark a session as superseded by a newer one, retire one as no-longer-relevant, or flag one as aborted-mid-flight. The next recall surfaces the corrected version, not the stale one. A claim from 6 months ago can be patched today.

---

## Development

```sh
git clone https://github.com/pbmagnet4/nlm-memory-ts
cd nlm-memory-ts
npm install
npm run build          # compile dist/ — commit the result, it ships in the repo
npm run dev            # hot-reload daemon
npm run ui:dev         # hot-reload UI at localhost:5173 (proxies /api to :3940)
npm test               # 612 tests across 64 files
npm run typecheck
```

Architecture: hexagonal. `src/core/` knows about ports (interfaces), not adapters. `src/cli/nlm.ts` is the composition root — the only file that wires concrete implementations (`SqliteSessionStore`, `OllamaClient`, `Hono`, `StdioServerTransport`). Adapters in `src/core/adapters/` are one-way: they parse runtime-specific session formats into NLM's canonical shape; nothing in the runtime sees NLM.

`dist/` is committed so `npm install -g` works without a build step. Rebuild + commit when you change `src/`.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
