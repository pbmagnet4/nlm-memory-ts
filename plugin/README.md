# nlm-memory Codex plugin

This directory is the Codex plugin distribution surface for nlm-memory. The
repo root acts as a Codex marketplace (`codex plugin marketplace add
pbmagnet4/nlm-memory-ts`), and this directory is the plugin Codex installs.

## Install

Prerequisite: `npm install -g nlm-memory` (puts `nlm` on PATH; the MCP server
spawns `nlm mcp`).

```bash
codex plugin marketplace add pbmagnet4/nlm-memory-ts
codex plugin add nlm-memory@nlm-memory-ts
```

Or use the wrapper: `nlm connect codex`.

## What ships

- **MCP server** (`.mcp.json`) — `recall_sessions`, `get_session`,
  `recall_facts`, `get_fact_history`. Spawns `nlm mcp` over stdio.
- **UserPromptSubmit hook** — injects up to 3 relevant prior sessions per
  fire, capped at 10 per conversation. Fail-open: any error yields no
  output, never blocks a prompt.
- **Stop hook** — scans the assistant turn for cited session IDs and posts
  citation events to the local daemon for learned reranking.

## What doesn't

Codex has no `SessionEnd` equivalent (CC does). The CC adapter uses
SessionEnd to clean up per-conversation memo files in
`~/.nlm/hook-state/`. The local daemon's `MemoSweepScheduler` (running every
5m, 24h threshold) cleans those up regardless of runtime, so the absence is
not a correctness issue — just a slight delay before stale memos are
collected.

## Hook trust

Codex requires per-hash trust before any plugin hook executes. On first
`codex` invocation after install, you'll be prompted to review and trust the
hook scripts in `scripts/`. Approve them once; trust persists per script
hash. Re-prompted whenever a new release ships new script hashes.

## Codex Desktop fallback

[openai/codex#16430](https://github.com/openai/codex/issues/16430) — Codex
Desktop builds currently do not dispatch plugin-local hooks. MCP tools still
work. If you're on Desktop, run `nlm connect codex --with-hooks` to write
absolute paths to `~/.codex/hooks.json` as a fallback. Remove the fallback
once #16430 ships.
