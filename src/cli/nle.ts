#!/usr/bin/env node
/**
 * nle — CLI entry point. Composition root for the whole stack.
 *
 * This is the one file that knows about every concrete implementation:
 * SqliteSessionStore (storage), OllamaClient (LLM), Hono (HTTP),
 * McpServer (MCP). Every other module depends on ports. Swapping a
 * backend means editing this file, not anything inside core/.
 *
 * Subcommands:
 *   nle start    — boot HTTP server on $NLE_PORT (default 3940)
 *   nle migrate  — run pending migrations against the canonical SQLite
 *   nle recall   — one-shot recall query from the shell (debugging)
 *   nle mcp      — run as an MCP stdio server (for ~/.mcp.json wiring)
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import { serve } from "@hono/node-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RecallService } from "../core/recall/recall-service.js";
import { SqliteSessionStore } from "../core/storage/sqlite-session-store.js";
import { createApp } from "../http/app.js";
import { createMcpServer } from "../mcp/server.js";
import { OllamaClient } from "../llm/ollama-client.js";
import { runParity } from "./classify-parity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const DEFAULT_DB_PATH = resolve(homedir(), ".nle/canonical.sqlite");
const DEFAULT_PORT = 3940;

function dbPath(): string {
  return process.env["NLE_DB_PATH"] ?? DEFAULT_DB_PATH;
}

function port(): number {
  const raw = process.env["NLE_PORT"];
  if (!raw) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65_535) return DEFAULT_PORT;
  return n;
}

function ollamaUrl(): string {
  return process.env["NLE_OLLAMA_URL"] ?? "http://localhost:11434";
}

function buildStack() {
  const store = new SqliteSessionStore({
    dbPath: dbPath(),
    migrationsDir: MIGRATIONS_DIR,
  });
  const llm = new OllamaClient({ baseUrl: ollamaUrl() });
  const recall = new RecallService({ store, llm });
  return { store, recall };
}

const program = new Command();
program
  .name("nle")
  .description("Local-first memory operating system for AI operators")
  .version("0.2.0-dev");

program
  .command("start")
  .description("Boot the HTTP server")
  .action(() => {
    const { store, recall } = buildStack();
    const app = createApp({ recall, store });
    const p = port();
    serve({ fetch: app.fetch, port: p }, (info) => {
      console.error(`nle-memory http listening on http://localhost:${info.port}`);
      console.error(`  db:     ${dbPath()}`);
      console.error(`  ollama: ${ollamaUrl()}`);
    });
  });

program
  .command("migrate")
  .description("Run pending migrations against the canonical SQLite")
  .action(() => {
    // SqliteSessionStore's constructor loads sqlite-vec and runs migrations.
    // Opening + closing is the whole operation.
    const store = new SqliteSessionStore({
      dbPath: dbPath(),
      migrationsDir: MIGRATIONS_DIR,
    });
    store.close();
    console.error(`nle-memory: migrations applied at ${dbPath()}`);
  });

program
  .command("recall")
  .description("One-shot recall query (for shell debugging)")
  .argument("<query>", "search query")
  .option("-e, --entity <name>", "filter by entity")
  .option("-k, --kind <kind>", "filter by marker kind (decision|open)")
  .option("-m, --mode <mode>", "keyword|semantic|hybrid", "keyword")
  .option("-l, --limit <n>", "max results", (v) => Number.parseInt(v, 10), 10)
  .action(async (query, opts) => {
    const { store, recall } = buildStack();
    try {
      const result = await recall.search({
        query,
        mode: opts.mode,
        limit: opts.limit,
        ...(opts.entity ? { entity: opts.entity } : {}),
        ...(opts.kind ? { kind: opts.kind } : {}),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } finally {
      store.close();
    }
  });

program
  .command("classify-parity")
  .description("Run TS classifier against ~/.nle/canonical.sqlite and diff vs persisted Python output")
  .option("-l, --limit <n>", "sessions to sample", (v) => Number.parseInt(v, 10), 10)
  .option("-m, --model <name>", "Ollama model tag", "phi4-mini:latest")
  .option("-v, --verbose", "per-session diff lines on stderr")
  .action(async (opts) => {
    const report = await runParity({
      limit: opts.limit,
      dbPath: dbPath(),
      ollamaUrl: ollamaUrl(),
      classifyModel: opts.model,
      verbose: Boolean(opts.verbose),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  });

program
  .command("mcp")
  .description("Run as an MCP stdio server (for ~/.mcp.json)")
  .action(async () => {
    const { recall, store } = buildStack();
    const server = createMcpServer({ recall, store });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });

program.parseAsync().catch((e) => {
  console.error("nle: fatal", e);
  process.exit(1);
});
