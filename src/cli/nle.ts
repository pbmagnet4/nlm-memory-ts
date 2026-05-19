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
import { SqliteFactStore } from "../core/storage/sqlite-fact-store.js";
import { SqliteSessionStore } from "../core/storage/sqlite-session-store.js";
import { createApp } from "../http/app.js";
import { createMcpServer } from "../mcp/server.js";
import { DeepSeekClient } from "../llm/deepseek-client.js";
import { OllamaClient } from "../llm/ollama-client.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { runParity } from "./classify-parity.js";
import { reembedCorpus } from "../core/embedding/embed-backfill.js";
import { normalizeEmbeddings } from "../core/embedding/embed-normalize.js";
import { ScanScheduler } from "../core/scheduler/scheduler.js";
import { ClaudeCodeAdapter } from "../core/adapters/claude-code.js";
import { HermesAdapter } from "../core/adapters/hermes.js";
import { PiAdapter } from "../core/adapters/pi.js";
import type { LLMClient } from "../ports/llm-client.js";
import type { TranscriptAdapter } from "../ports/transcript-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const UI_DIST = resolve(__dirname, "../../dist/ui");
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

function buildClassifier(): LLMClient {
  // DeepSeek V4 Flash is the default for the ingest classifier per the
  // 2026-05-19 parity run: ~5s/session, 90% first-try success vs Ollama
  // phi4-mini's 0% on the same first three sessions. Override with
  // NLE_CLASSIFIER=ollama if you need offline-only operation.
  const provider = (process.env["NLE_CLASSIFIER"] ?? "deepseek").toLowerCase();
  if (provider === "ollama") {
    return new OllamaClient({ baseUrl: ollamaUrl() });
  }
  autoloadEnv();
  return new DeepSeekClient();
}

function buildAdapters(): TranscriptAdapter[] {
  // Honor adapter detection — only register adapters whose data dir exists.
  // The user can force-enable via NLE_ADAPTERS=claude-code,hermes,pi.
  const explicit = process.env["NLE_ADAPTERS"];
  const all: TranscriptAdapter[] = [
    new ClaudeCodeAdapter(),
    new HermesAdapter(),
    new PiAdapter(),
  ];
  if (explicit) {
    const names = new Set(explicit.split(",").map((s) => s.trim()));
    return all.filter((a) => names.has(a.name));
  }
  return all.filter((a) => a.detect().enabled);
}

function buildStack() {
  const store = new SqliteSessionStore({
    dbPath: dbPath(),
    migrationsDir: MIGRATIONS_DIR,
  });
  // FactStore shares the SessionStore's connection so session+facts ingest
  // can commit in one transaction. Phase B.1 wires it in; no callers yet.
  const facts = new SqliteFactStore(store.rawDb());
  // Recall only uses embed(). Embeddings live on Ollama; DeepSeek doesn't
  // expose them. Classifier is wired separately for Phase D ingest.
  const embedder = new OllamaClient({ baseUrl: ollamaUrl() });
  const classifier = buildClassifier();
  const recall = new RecallService({ store, llm: embedder });
  return { store, facts, recall, embedder, classifier };
}

const program = new Command();
program
  .name("nle")
  .description("Local-first memory operating system for AI operators")
  .version("0.2.0-dev");

program
  .command("start")
  .description("Boot the HTTP server + ingest scheduler")
  .option("--no-scheduler", "HTTP only; skip the ingest tick loop")
  .option("--interval-min <n>", "scheduler tick interval (min, default 30)", (v) => Number.parseInt(v, 10), 30)
  .action(async (opts) => {
    const { store, recall, embedder, classifier } = buildStack();
    const { existsSync } = await import("node:fs");
    const classifierProvider = (process.env["NLE_CLASSIFIER"] ?? "deepseek").toLowerCase();
    const app = createApp({
      recall,
      store,
      liveStore: store,
      dbPath: dbPath(),
      classifierInfo: {
        provider: classifierProvider,
        model: classifierProvider === "ollama" ? "phi4-mini:latest" : "deepseek-v4-flash",
      },
      ...(existsSync(UI_DIST) ? { uiDist: UI_DIST } : {}),
    });
    const p = port();
    serve({ fetch: app.fetch, port: p }, (info) => {
      console.error(`nle-memory http listening on http://localhost:${info.port}`);
      console.error(`  db:     ${dbPath()}`);
      console.error(`  ollama: ${ollamaUrl()}`);
    });

    if (opts.scheduler !== false) {
      const adapters = buildAdapters();
      if (adapters.length === 0) {
        console.error("  scheduler: no adapters detected (set NLE_ADAPTERS to force-enable)");
      } else {
        const scheduler = new ScanScheduler({
          store,
          adapters,
          classifier,
          embedder,
          intervalMs: opts.intervalMin * 60_000,
        });
        scheduler.start();
        console.error(
          `  scheduler: ${adapters.map((a) => a.name).join(", ")} every ${opts.intervalMin}m`,
        );
        const shutdown = () => {
          scheduler.stop();
          store.close();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      }
    }
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
  .option("-p, --provider <name>", "deepseek | ollama", "deepseek")
  .option("-m, --model <name>", "model tag (default: deepseek-v4-flash for deepseek, phi4-mini:latest for ollama)")
  .option("-v, --verbose", "per-session diff lines on stderr")
  .action(async (opts) => {
    const provider = opts.provider === "ollama" ? "ollama" : "deepseek";
    const defaultModel = provider === "deepseek" ? "deepseek-v4-flash" : "phi4-mini:latest";
    const report = await runParity({
      limit: opts.limit,
      dbPath: dbPath(),
      ollamaUrl: ollamaUrl(),
      classifyModel: opts.model ?? defaultModel,
      provider,
      verbose: Boolean(opts.verbose),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  });

program
  .command("embed-backfill")
  .description("Re-embed every session in canonical.sqlite with the document prefix")
  .option("-l, --limit <n>", "session cap (default: all)", (v) => Number.parseInt(v, 10))
  .option("--body-chars <n>", "body truncation (default 4000)", (v) => Number.parseInt(v, 10), 4_000)
  .option("--state <path>", "resume state file (default ~/.nle/embed_reembed.state)")
  .option("-v, --verbose", "per-session progress on stderr")
  .action(async (opts) => {
    const embedder = new OllamaClient({ baseUrl: ollamaUrl() });
    const report = await reembedCorpus({
      dbPath: dbPath(),
      embedder,
      ...(opts.state ? { statePath: opts.state } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      bodyChars: opts.bodyChars,
      ...(opts.verbose
        ? {
            onProgress: (i: number, n: number, sid: string, status: string) => {
              process.stderr.write(`  [${i}/${n}] ${sid}  ${status}\n`);
            },
          }
        : {}),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  });

program
  .command("embed-normalize")
  .description("L2-normalize every row in session_embeddings (idempotent)")
  .option("--dim <n>", "vector dimension (default 768)", (v) => Number.parseInt(v, 10), 768)
  .option("--batch <n>", "rows per commit batch (default 100)", (v) => Number.parseInt(v, 10), 100)
  .option("--dry-run", "report what would change without writing")
  .action((opts) => {
    const report = normalizeEmbeddings({
      dbPath: dbPath(),
      dim: opts.dim,
      batchSize: opts.batch,
      dryRun: Boolean(opts.dryRun),
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
