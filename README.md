# nlm-memory

> Local-first memory OS for AI operators — one corpus across every runtime you use.

`nlm-memory` indexes every session from Claude Code, Codex, OpenCode, Cursor, Windsurf, Hermes, Aider, and pi into a single searchable store on your machine. Three properties no competitor ships together:

1. **Cross-runtime reach.** One index spans every adapter — not one per runtime.
2. **Editable timeline.** Sessions can be superseded, retired, or marked aborted. Memory is non-linear: patch history retroactively. No other memory layer lets you do this.
3. **97.2% R@5 baseline.** On a 14-month corpus, keyword recall surfaces the right session in the top 5 on 97.2% of evaluator queries. No fine-tuning, no cloud, no account.

Everything stays on your machine. No telemetry, no account required beyond your classifier of choice.

---

## Requirements

- **Node 20+**
- **[Ollama](https://ollama.com)** running locally with `nomic-embed-text` pulled for semantic search:
  ```sh
  ollama pull nomic-embed-text
  ```
- **A classifier** — pick during setup:
  - **DeepSeek cloud** (recommended for speed) — fast, cheap (~$0.002/session). Sends up to 30K chars of each session transcript to `api.deepseek.com`.
  - **Ollama local** — fully offline. Slower; uses whichever chat model you select from your local pull list.

---

## Install

```sh
npm install -g nlm-memory
nlm setup
```

`nlm setup` is the interactive first-run wizard. It asks you to pick your classifier, model, and which runtimes to connect (Claude Code, Codex, Hermes), then installs the daemon. After it finishes, open **http://localhost:3940/ui** — done.

### Platform support

| Platform | Daemon | Notes |
|---|---|---|
| **macOS** | LaunchAgent at `~/Library/LaunchAgents/com.github.pbmagnet4.nlm-memory.plist` | Auto-starts on login |
| **Linux** | systemd user unit at `~/.config/systemd/user/nlm.service` | Run `loginctl enable-linger $USER` on headless servers so the daemon survives logout |
| **Windows** | Manual `nlm start` for now | Hook + MCP install paths are platform-aware; daemon supervisor lands in the next release |

To stop or remove:
```sh
nlm uninstall   # remove the daemon supervisor on your platform
```

---

## How recall works

Once installed, NLM runs as a quiet background daemon. Two ways your AI agents get to it:

### 1. Hooks (Claude Code) — automatic context injection

`nlm connect claude-code` installs five hooks into `~/.claude/settings.json`:

- **UserPromptSubmit / SessionStart** — before each turn, NLM scores the prompt against your past sessions and silently prepends a pointer block listing the 0–3 most likely-relevant prior sessions. The model sees them as conversational context.
- **Stop** — after the model responds, NLM scans the response for citations of surfaced session IDs to measure useful-hit rate.
- **PreCompact / SubagentStart** — link conversations across compactions and subagent dispatches so threads stay coherent.

Default mode is **live** (recall injected into prompts). Switch to **shadow** (log-only, no injection) by setting `NLM_HOOK_MODE=shadow` in your hook commands.

### 2. MCP — explicit tools any agent can call

```sh
nlm connect claude-code      # writes ~/.mcp.json + installs hooks
nlm connect codex            # installs as a Codex marketplace plugin
nlm connect hermes           # writes ~/.hermes/config.yaml (MCP)
nlm connect hermes-agent     # installs as a NousResearch Hermes plugin (hooks + MCP)
```

Once wired, agents can call `recall_sessions` (search past conversations), `recall_facts` (decisions/open questions/project state), `get_session` (pull a full session), `get_fact_history` (how a decision evolved), and `cite_session` (explicitly mark a session as referenced).

For container-hosted agents that can't use stdio MCP, the daemon also exposes Streamable-HTTP MCP at `POST /mcp`. Use the auto-generated `NLM_MCP_TOKEN` from `~/.nlm/.env` as a bearer.

---

## What's inside the UI

Open `http://localhost:3940/ui` after the daemon starts.

| Page | What it shows |
|---|---|
| **Live** | Sessions being written in real time, recent reads and decisions |
| **Pulse** | System health — coherence, runtimes, stale entities, recent sessions |
| **River** | Full session timeline with density controls and supersedence visualization |
| **Thread** | Per-entity conversation history with runtime filters |
| **Search** | Keyword, semantic, or hybrid recall with match snippets |
| **Recall** | Adoption telemetry — is the memory system actually being used? |
| **Settings** | Sources, providers, classifier, data backup/restore |

---

## Daily digest

Get a once-a-day summary of yesterday's recall activity:

```sh
nlm digest                    # print to stdout
nlm digest --telegram         # post to Telegram (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
```

The digest reports 24-hour real-traffic volume (probes filtered), 7-day hit rate, top queries, and a hook-liveness alert if Claude Code ran but the recall hook didn't fire. Wire it to cron for a morning push:

```cron
0 7 * * *  TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… nlm digest --telegram
```

---

## Security

NLM is local-first by design. The daemon:

- Binds to `127.0.0.1` only — never `0.0.0.0`.
- Enforces Host + Origin checks on `/api/*` to block DNS rebinding and cross-origin drive-by.
- Generates a 256-bit `NLM_MCP_TOKEN` on first run and persists to `~/.nlm/.env` (mode `0600`). All non-browser API requests (hooks, MCP container clients) authenticate with `Authorization: Bearer ${NLM_MCP_TOKEN}`.
- Recursively enforces `0700` on `~/.nlm/` and `0600` on its contents on every start.
- Sends nothing outbound except:
  - Ollama (`localhost:11434`) for embeddings + local classifier
  - DeepSeek API (`api.deepseek.com`) — only when classifier is set to DeepSeek
  - Your AI runtime transcript files (read-only)

No telemetry. No vendor calls. No account.

Report vulnerabilities via [SECURITY.md](SECURITY.md).

---

## Upgrading from v0.4.x

```sh
npm update -g nlm-memory
```

Old installs have `NLM_HOOK_MODE=shadow` hardcoded in `~/.claude/settings.json` — shadow mode is silent, so re-run `nlm hook install` to switch to live recall injection. Permissions and `NLM_MCP_TOKEN` self-heal on the next `nlm start`.

---

## How it differs from mem0 and graphiti

- **Unit of memory:** whole sessions with extracted markers (decisions, open questions, entities), not individual facts or graph edges.
- **Audience:** you querying your own past work, not an embedded SDK for app developers.
- **Cross-runtime:** one corpus across Claude Code, Codex, OpenCode, Cursor, Windsurf, Hermes, and more. Competitors target one runtime.
- **Editable timeline:** sessions can be superseded, retired, aborted. No other tool lets you retrofit memory — a record from 6 months ago can be corrected today.
- **Local-only:** no hosted offering, no telemetry, no vendor dependency.

---

## Development

```sh
git clone https://github.com/pbmagnet4/nlm-memory-ts
cd nlm-memory-ts
npm install        # install dependencies
npm run build      # compile dist/ — commit the result, it ships in the repo
npm run dev        # hot-reload daemon
npm run ui:dev     # hot-reload UI at localhost:5173 (proxies /api to :3940)
npm test           # 601 tests across 62 files
npm run typecheck
```

`dist/` is committed to the repo so the global install works without a build step on the user's machine. Rebuild and commit `dist/` whenever you change `src/`.

Database lives at `~/.nlm/canonical.sqlite`. Override with `NLM_DB_PATH`.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
