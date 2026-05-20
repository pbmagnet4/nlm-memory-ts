# nlm-memory

> NLM (Non-Linear Memory) — a local-first memory operating system for AI operators.

`nlm-memory` indexes every AI session you run — Claude Code, Hermes, pi, Codex, Gemini, Aider — into a single searchable store on your machine. Recall by keyword, semantic similarity, or hybrid. Browse in a local web UI. Plug into any agent via MCP so it can query your history automatically.

Everything stays on your machine. No cloud, no account, no API key required (except your classifier of choice).

---

## Requirements

- **Node 20+**
- **[Ollama](https://ollama.com)** running locally with `nomic-embed-text` pulled:
  ```sh
  ollama pull nomic-embed-text
  ```
- **A classifier** — [DeepSeek](https://platform.deepseek.com) is recommended (fast, cheap, ~$0.002/session). Set `DEEPSEEK_API_KEY` in `~/.nlm/.env`. Ollama works offline with `NLM_CLASSIFIER=ollama`.

---

## Install

```sh
npm install -g github:pbmagnet4/nlm-memory-ts
nlm migrate
nlm install
```

`nlm install` writes a macOS LaunchAgent that starts the daemon on login and keeps it running. Open **http://localhost:3940/ui** — done.

To stop or remove:
```sh
launchctl stop io.whtnxt.nlm-memory   # stop without uninstalling
nlm uninstall                          # remove the LaunchAgent entirely
```

---

## Wire to your AI agents (MCP)

Add to `~/.mcp.json` (or your editor's MCP config):

```json
{
  "mcpServers": {
    "nlm-memory": {
      "command": "node",
      "args": ["<path-to-global-npm>/lib/node_modules/nlm-memory/dist/cli/nlm.js", "mcp"]
    }
  }
}
```

Find the path with `npm root -g` — the full path is `$(npm root -g)/nlm-memory/dist/cli/nlm.js`.

Once wired, agents can call `recall_sessions` (search past conversations) and `recall_facts` (pull structured facts like decisions and project state) automatically.

---

## What's inside

| Page | What it shows |
|---|---|
| **Live** | Sessions being written in real time, recent reads and decisions |
| **Pulse** | System health — coherence, runtimes, stale entities, recent sessions |
| **River** | Full session timeline with density controls |
| **Thread** | Per-entity conversation history |
| **Search** | Keyword, semantic, or hybrid recall |
| **Recall** | Adoption telemetry — is the memory system actually being used? |
| **Settings** | Sources, providers, classifier, data backup/restore |

---

## How it differs from mem0 and graphiti

- **Unit of memory:** whole sessions with extracted markers (decisions, open questions, entities), not individual facts or graph edges.
- **Audience:** you querying your own past work, not an embedded SDK for app developers.
- **Cross-runtime:** one corpus across every AI tool you use. This is the moat.
- **Editable timeline:** sessions can be superseded, retired, aborted. Memory is non-linear.
- **Local-only:** no hosted offering, no telemetry.

---

## Development

```sh
git clone https://github.com/pbmagnet4/nlm-memory-ts
cd nlm-memory-ts
npm install        # installs deps + builds
npm run dev        # hot-reload daemon
npm run ui:dev     # hot-reload UI at localhost:5173 (proxies /api to :3940)
npm test           # unit + integration tests
npm run typecheck
```

Database lives at `~/.nlm/canonical.sqlite`. Override with `NLM_DB_PATH`.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
