#!/usr/bin/env node
/**
 * nlm — CLI entry point. Composition root for the whole stack.
 *
 * This is the one file that knows about every concrete implementation:
 * SqliteSessionStore (storage), OllamaClient (LLM), Hono (HTTP),
 * McpServer (MCP). Every other module depends on ports. Swapping a
 * backend means editing this file, not anything inside core/.
 *
 * Subcommands:
 *   nlm start    — boot HTTP server on $NLM_PORT (default 3940)
 *   nlm migrate  — run pending migrations against the canonical SQLite
 *   nlm recall   — one-shot recall query from the shell (debugging)
 *   nlm mcp      — run as an MCP stdio server (for ~/.mcp.json wiring)
 *   nlm setup    — interactive first-run wizard (recommended entry point)
 *   nlm install  — install the macOS LaunchAgent (auto-start on login)
 *   nlm uninstall — remove the macOS LaunchAgent
 *   nlm hook install   — add the recall hook to Claude Code (shadow mode)
 *   nlm hook uninstall — remove the recall hook from Claude Code
 *   nlm connect claude-code  — write MCP server block to ~/.mcp.json
 *   nlm connect codex        — install Codex marketplace plugin
 *   nlm disconnect claude-code — remove MCP block from ~/.mcp.json
 *   nlm disconnect codex       — remove Codex plugin
 *   nlm digest   — print a daily-activity digest (or --telegram to post)
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { serve } from "@hono/node-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FactRecallService } from "../core/recall-facts/fact-recall-service.js";
import { RecallService } from "../core/recall/recall-service.js";
import { ProviderRegistry } from "../core/providers/provider-registry.js";
import { SourceRegistry } from "../core/sources/source-registry.js";
import { SqliteStorage } from "../core/storage/sqlite-storage.js";
import { PgStorage } from "../core/storage/pg-storage.js";
import { PgSourceRegistry } from "../core/sources/source-registry.js";
import { PgProviderRegistry } from "../core/providers/provider-registry.js";
import { applyPendingRestore } from "../core/storage/db-restore.js";
import { createApp } from "../http/app.js";
import { createMcpServer } from "../mcp/server.js";
import { ClassifierBox, type ClassifierProvider } from "../llm/classifier-box.js";
import { DeepSeekClient } from "../llm/deepseek-client.js";
import { OllamaClient } from "../llm/ollama-client.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { addHook, buildHookCommand, removeHook } from "../core/hook/claude-settings.js";
import {
  codexBinaryAvailable,
  connectCodex,
  disconnectCodex,
  pluginScriptsDir,
} from "../install/codex.js";
import { connectClaudeCode, disconnectClaudeCode, installClaudeCodeHooks, mcpConfigPath } from "../install/claude-code.js";
import { hardenNlmDirPermissions } from "../install/nlm-dir-perms.js";
import { ensureMcpToken } from "../install/ollama.js";
import { connectCursor, disconnectCursor } from "../install/cursor.js";
import {
  describeRemove,
  describeUpsert,
  installCursorRules,
  installOpencodeRules,
  installWindsurfRules,
  uninstallCursorRules,
  uninstallOpencodeRules,
  uninstallWindsurfRules,
} from "../install/rules-install.js";
import { runSupersedeCommand } from "./supersede.js";
import { getUpdateStatus } from "../core/update-check/check.js";
import { connectHermes, disconnectHermes, hermesConfigPath } from "../install/hermes.js";
import { connectHermesAgent, disconnectHermesAgent, hermesAgentPluginDir } from "../install/hermes-agent.js";
import { connectWindsurf, disconnectWindsurf } from "../install/windsurf.js";
import { connectPi, disconnectPi, piSettingsPath } from "../install/pi.js";
import { runSetup } from "../install/setup.js";
import { runParity } from "./classify-parity.js";
import { reembedCorpus } from "../core/embedding/embed-backfill.js";
import { backfillFacts } from "../core/facts/backfill-facts.js";
import { normalizeEmbeddings } from "../core/embedding/embed-normalize.js";
import { ScanScheduler } from "../core/scheduler/scheduler.js";
import { MemoSweepScheduler } from "../core/hook/memo-sweep.js";
import { isAgentLoaded, isBenignBootoutError } from "./launchctl-helpers.js";
import { DAEMON_PKILL_PATTERN, planRestart, executeRestartPlan, type ExecuteRestartPlanDeps } from "./restart-helpers.js";
import { isDevBuild, updateCheckCachePath } from "./upgrade-helpers.js";
import { applyEnvAssignment } from "./config-env.js";
import { adapterFromSource } from "../core/adapters/from-source.js";
import type { TranscriptAdapter } from "../ports/transcript-adapter.js";
import { runDigest } from "./digest.js";
import { installScope } from "../core/signals/install-scope.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const PG_MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);
const UI_DIST = resolve(__dirname, "../../dist/ui");
const DEFAULT_DB_PATH = resolve(homedir(), ".nlm/canonical.sqlite");
const DEFAULT_PORT = 3940;

function dbPath(): string {
  return process.env["NLM_DB_PATH"] ?? DEFAULT_DB_PATH;
}

function port(): number {
  const raw = process.env["NLM_PORT"];
  if (!raw) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65_535) return DEFAULT_PORT;
  return n;
}

function ollamaUrl(): string {
  return process.env["NLM_OLLAMA_URL"] ?? "http://localhost:11434";
}

function buildClassifier(): ClassifierBox {
  // qwen3:4b-instruct-2507-q4_K_M is the recommended local classifier per the
  // 2026-06-02 head-to-head bench (reports/classifier-comparison/2026-06-02-deepseek-v4-vs-qwen3.md):
  // statistical tie with DeepSeek V4 Flash on schema validity and entity/decision
  // counts, with better open-question coverage (100% vs 75%). Ollama is the
  // default to keep the daemon local-first and key-free; DeepSeek remains
  // available via NLM_CLASSIFIER=deepseek for users who prioritize speed.
  const provider = ((process.env["NLM_CLASSIFIER"] ?? "ollama").toLowerCase() as ClassifierProvider);
  if (provider !== "ollama") autoloadEnv();
  const model = process.env["NLM_CLASSIFIER_MODEL"]
    ?? (provider === "ollama" ? "qwen3:4b-instruct-2507-q4_K_M" : "deepseek-v4-flash");
  return new ClassifierBox({ provider, model, ollamaUrl: ollamaUrl() });
}

async function buildAdapters(sources: SourceRegistry | PgSourceRegistry): Promise<TranscriptAdapter[]> {
  // Sources table is the source of truth. Each enabled row maps to one
  // adapter via adapterFromSource(). Detection still gates registration —
  // a row pointing at a missing dir won't poll. NLM_ADAPTERS keeps working
  // as a name-based filter for forcing a subset during dev.
  const explicit = process.env["NLM_ADAPTERS"];
  const allowed = explicit ? new Set(explicit.split(",").map((s) => s.trim())) : null;
  const rows = await sources.list();
  const out: TranscriptAdapter[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    const adapter = adapterFromSource(row);
    if (!adapter) continue;
    if (allowed && !allowed.has(adapter.name)) continue;
    if (!adapter.detect().enabled) continue;
    out.push(adapter);
  }
  return out;
}

async function buildStorage(path: string): Promise<SqliteStorage | PgStorage> {
  const pgUrl = process.env["NLM_PG_URL"];
  if (pgUrl) {
    const storage = PgStorage.create({ connectionString: pgUrl, migrationsDir: PG_MIGRATIONS_DIR });
    await storage.init();
    return storage;
  }
  return SqliteStorage.create({ dbPath: path, migrationsDir: MIGRATIONS_DIR });
}

async function buildStack() {
  // Load .env before any registry seeds so secrets carried in env vars
  // (DEEPSEEK_API_KEY today; OPENAI_API_KEY etc. tomorrow) bridge into
  // the providers table on first boot under launchd.
  autoloadEnv();
  // A restore staged via POST /api/data/restore is promoted here, before
  // the store opens — the daemon can't swap a DB file it already holds.
  const restored = applyPendingRestore(dbPath());
  if (restored.applied) {
    console.error(`nlm-memory: restored database from staged backup`);
    if (restored.archivedTo) console.error(`  previous db archived at ${restored.archivedTo}`);
  }
  const storage = await buildStorage(dbPath());
  const store = storage.sessions;
  // FactStore shares the SessionStore's connection so session+facts ingest
  // can commit in one transaction. Phase B.1 wires it in; no callers yet.
  const facts = storage.facts;
  const signals = storage.signals;
  const scope = installScope();
  // TODO(#215a): replace storage.rawDb() with port methods
  const sources = storage instanceof PgStorage
    ? new PgSourceRegistry(storage.pgPool())
    : new SourceRegistry((storage as SqliteStorage).rawDb());
  await sources.seedDefaults();
  // TODO(#215a): replace storage.rawDb() with port methods
  const providers = storage instanceof PgStorage
    ? new PgProviderRegistry(storage.pgPool())
    : new ProviderRegistry((storage as SqliteStorage).rawDb());
  if (providers instanceof ProviderRegistry) providers.seedDefaults();
  // Recall only uses embed(). Embeddings live on Ollama; DeepSeek doesn't
  // expose them. Classifier is wired separately for Phase D ingest.
  const embedder = new OllamaClient({ baseUrl: ollamaUrl() });
  const classifier = buildClassifier();
  const recall = new RecallService({ store, llm: embedder, factStore: facts });
  const factRecall = new FactRecallService({ factStore: facts, llm: embedder });
  return { storage, store, facts, signals, scope, sources, providers, recall, factRecall, embedder, classifier };
}

const program = new Command();
program
  .name("nlm")
  .description("Local-first memory operating system for AI operators")
  .version(pkg.version);

program
  .command("start")
  .description("Boot the HTTP server + ingest scheduler")
  .option("--no-scheduler", "HTTP only; skip the ingest tick loop")
  .option("--interval-min <n>", "scheduler tick interval (min, default 30)", (v) => Number.parseInt(v, 10), 30)
  .action(async (opts) => {
    // Self-heal perms on every daemon start. Idempotent. Covers upgrade
    // path from pre-v0.4.2 installs where ~/.nlm contents were world-readable.
    hardenNlmDirPermissions();
    // Generate NLM_MCP_TOKEN if missing so /api/* gets Bearer-protected for
    // non-browser callers. Idempotent: re-reads persisted token first.
    autoloadEnv();
    ensureMcpToken();
    const { storage, store, facts, signals, scope, sources, providers, recall, factRecall, embedder, classifier } = await buildStack();
    const { existsSync } = await import("node:fs");
    const hasMcpToken = Boolean(process.env["NLM_MCP_TOKEN"]);
    const app = createApp({
      recall,
      store,
      liveStore: store,
      factRecall,
      factStore: facts,
      dbPath: dbPath(),
      classifier,
      sources,
      providers,
      // TODO(#215a): PgStorage ingest port; cast until then
      ...(!(storage instanceof PgStorage) ? {
        ingest: {
          classifier,
          embedder,
          store: store as import("../core/storage/sqlite-session-store.js").SqliteSessionStore,
          ...(facts ? { factStore: facts as import("../core/storage/sqlite-fact-store.js").SqliteFactStore } : {}),
        },
      } : {}),
      signalStore: signals,
      installScope: scope,
      embedderInfo: { provider: "ollama", model: "nomic-embed-text", dims: 768 },
      ...(existsSync(UI_DIST) ? { uiDist: UI_DIST } : {}),
      // Wire POST /mcp only when NLM_MCP_TOKEN is present. Absent = route never
      // mounts, zero attack surface. Present = token-gated Streamable-HTTP MCP
      // endpoint for container agents (e.g. Hermes WebUI).
      ...(hasMcpToken
        ? { mcpDeps: { recall, store, factRecall, factStore: facts } }
        : {}),
    });
    const p = port();
    serve({ fetch: app.fetch, port: p, hostname: "127.0.0.1" }, (info) => {
      console.error(`nlm-memory http listening on http://localhost:${info.port}`);
      if (hasMcpToken) {
        console.error(`  mcp:    http://localhost:${info.port}/mcp (token-gated)`);
      }
      console.error(`  db:     ${dbPath()}`);
      console.error(`  ollama: ${ollamaUrl()}`);
      // Passive update notice. Fire-and-forget so a slow npm registry
      // round-trip can't delay the startup banner; surfaced only when
      // strictly behind. See src/core/update-check/check.ts for the
      // local-first / no-telemetry contract this honors.
      void getUpdateStatus({ currentVersion: pkg.version }).then((status) => {
        if (status.behind && status.latest) {
          console.error(
            `  update: ${status.current} → ${status.latest} available (npm i -g nlm-memory@latest)`,
          );
        }
      });
    });

    // Keep the SQLite WAL bounded. WAL mode is on but nothing else
    // checkpoints it; under continuous readers it grows without limit
    // (it had reached 38 MB), which slows every read. Drain once at boot,
    // then every 5 minutes. Skip entirely when using PgStorage (no WAL).
    const checkpointTimer = !(storage instanceof PgStorage)
      ? (() => {
          const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60_000;
          const sqliteStore = store as import("../core/storage/sqlite-session-store.js").SqliteSessionStore;
          try {
            sqliteStore.checkpoint();
          } catch {
            // Boot checkpoint can lose a race with readers — the interval retries.
          }
          const t = setInterval(() => {
            try {
              sqliteStore.checkpoint();
            } catch {
              // Checkpoint contention — the next tick retries.
            }
          }, WAL_CHECKPOINT_INTERVAL_MS);
          t.unref();
          return t;
        })()
      : null;

    // Signal retention prune. Best-effort, every 6h, default 90d. Runs on
    // both SQLite and Pg backends since both expose pruneOlderThan().
    const parsedRetentionDays = Number.parseInt(process.env["NLM_SIGNAL_RETENTION_DAYS"] ?? "90", 10);
    const SIGNAL_RETENTION_DAYS = Number.isFinite(parsedRetentionDays) && parsedRetentionDays > 0 ? parsedRetentionDays : 90;
    const SIGNAL_PRUNE_INTERVAL_MS = 6 * 60 * 60_000;
    const signalPruneTimer = setInterval(() => {
      const cutoff = new Date(Date.now() - SIGNAL_RETENTION_DAYS * 86_400_000).toISOString();
      void signals.pruneOlderThan(cutoff).catch(() => { /* prune is best-effort */ });
    }, SIGNAL_PRUNE_INTERVAL_MS);
    signalPruneTimer.unref();

    // Memo sweep runs independently of the transcript scheduler — it's the
    // backstop for SessionEnd hook unreliability (crashes, kill -9, IDE
    // force-close don't fire SessionEnd, so memo files would otherwise
    // accumulate forever). Always on, even when --no-scheduler.
    const memoSweep = new MemoSweepScheduler();
    memoSweep.start();
    console.error("  memo sweep: dormant cleanup every 5m (threshold 24h)");

    if (opts.scheduler !== false && !(storage instanceof PgStorage)) {
      const adapters = await buildAdapters(sources);
      if (adapters.length === 0) {
        console.error("  scheduler: no adapters detected (set NLM_ADAPTERS to force-enable)");
      } else {
        const scheduler = new ScanScheduler({
          // TODO(#215a): PgStorage scheduler port; SQLite-only until then
          store: store as import("../core/storage/sqlite-session-store.js").SqliteSessionStore,
          adapters,
          classifier,
          embedder,
          factStore: (facts as import("../core/storage/sqlite-fact-store.js").SqliteFactStore | null | undefined) ?? null,
          signalStore: signals,
          installScope: scope,
          intervalMs: opts.intervalMin * 60_000,
        });
        scheduler.start();
        console.error(
          `  scheduler: ${adapters.map((a) => a.name).join(", ")} every ${opts.intervalMin}m`,
        );
        const shutdown = async () => {
          if (checkpointTimer) clearInterval(checkpointTimer);
          scheduler.stop();
          memoSweep.stop();
          await storage.close();
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
  .action(async () => {
    // SqliteSessionStore's constructor loads sqlite-vec and runs migrations.
    // Opening + closing is the whole operation.
    const storage = SqliteStorage.create({
      dbPath: dbPath(),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    await storage.close();
    console.error(`nlm-memory: migrations applied at ${dbPath()}`);
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
    const { storage, recall } = await buildStack();
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
      await storage.close();
    }
  });

program
  .command("misses")
  .description("Show sessions the agent explicitly fetched but the hook never surfaced (recall miss log)")
  .option("-d, --days <n>", "lookback window", (v) => Number.parseInt(v, 10), 7)
  .option("--json", "emit JSON instead of a human-readable table")
  .action(async (opts) => {
    const { missStats } = await import("../core/recall/miss-log.js");
    const stats = await missStats(opts.days);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      return;
    }
    if (!stats.logPresent) {
      console.error(`No miss log at ${process.env["NLM_MISS_LOG"] ?? "~/.nlm/miss-log.jsonl"}.`);
      console.error("Misses are recorded by the Stop hook when the agent explicitly fetches or cites a session NLM didn't surface.");
      return;
    }
    console.log(`Recall misses — last ${stats.days} day(s)`);
    console.log(`  Total miss events: ${stats.total}`);
    console.log(`  Distinct missed session IDs: ${stats.distinctIds}`);
    if (stats.topIds.length === 0) {
      console.log("  (no misses in this window)");
      return;
    }
    console.log("");
    console.log("  Top missed session IDs:");
    for (const row of stats.topIds) {
      console.log(`    ${row.id}  ×${row.count}  (in ${row.conversations} conv${row.conversations === 1 ? "" : "s"})`);
    }
  });

program
  .command("precision")
  .description(
    "Compute real-world recall precision: fraction of surfaced sessions that were later cited.",
  )
  .option("--days <n>", "lookback window in days", (v) => Number.parseInt(v, 10), 30)
  .option("--json", "emit JSON instead of human-readable output")
  .option("--verbose", "show per-conversation breakdown")
  .action(async (opts) => {
    const { computePrecision } = await import("../core/recall/precision.js");
    const { readQueryLog } = await import("../core/recall/query-log.js");
    const { readCitationLog } = await import("../core/recall/citation-log.js");

    const [queryEntries, citationEntries] = await Promise.all([
      readQueryLog(opts.days),
      readCitationLog(opts.days),
    ]);

    const result = computePrecision(queryEntries, citationEntries);

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (result.precisionAtK === null) {
      console.log("No scoreable conversations in the last " + opts.days + " day(s).");
      console.log(
        "  Precision requires both recall queries (query_log.jsonl) and explicit citations",
      );
      console.log(
        "  (citation_log.jsonl). If citations are empty, run: nlm help close-loop",
      );
      return;
    }

    const pct = (result.precisionAtK * 100).toFixed(1);
    console.log(`Recall precision@k — last ${opts.days} day(s)`);
    console.log(`  Precision: ${pct}%  (${result.conversationCount} conversations scored)`);

    if (opts.verbose && result.perConversation.length > 0) {
      console.log("\nPer-conversation breakdown (worst first):");
      for (const row of result.perConversation) {
        const p = (row.precision * 100).toFixed(0).padStart(3);
        console.log(`  ${p}%  surfaced=${row.surfaced}  cited=${row.cited}  ${row.conversationId}`);
      }
    }
  });

program
  .command("supersede")
  .description("Retroactively mark a session as superseded by a newer one")
  .argument("[predecessor]", "predecessor session id (omit for interactive search)")
  .argument("[successor]", "successor session id (omit for interactive search)")
  .option("-r, --reason <text>", "optional rationale (logged to ~/.nlm/supersedence-log.jsonl)")
  .option("-y, --yes", "skip confirmation")
  .action(async (predecessorArg, successorArg, opts) => {
    await runSupersedeCommand({
      predecessor: predecessorArg,
      successor: successorArg,
      reason: opts.reason,
      yes: Boolean(opts.yes),
    });
  });

program
  .command("classify-parity")
  .description("Run TS classifier against ~/.nlm/canonical.sqlite and diff vs persisted Python output")
  .option("-l, --limit <n>", "sessions to sample", (v) => Number.parseInt(v, 10), 10)
  .option("-p, --provider <name>", "deepseek | ollama", "deepseek")
  .option("-m, --model <name>", "model tag (default: deepseek-v4-flash for deepseek, qwen3:4b-instruct-2507-q4_K_M for ollama)")
  .option("-v, --verbose", "per-session diff lines on stderr")
  .action(async (opts) => {
    const provider = opts.provider === "ollama" ? "ollama" : "deepseek";
    const defaultModel = provider === "deepseek" ? "deepseek-v4-flash" : "qwen3:4b-instruct-2507-q4_K_M";
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
  .description("Re-embed every session into session_embedding_chunks (chunk + max-pool)")
  .option("-l, --limit <n>", "session cap (default: all)", (v) => Number.parseInt(v, 10))
  .option("--state <path>", "resume state file (default ~/.nlm/embed_reembed.state)")
  .option("-v, --verbose", "per-session progress on stderr")
  .action(async (opts) => {
    const embedder = new OllamaClient({ baseUrl: ollamaUrl() });
    const report = await reembedCorpus({
      dbPath: dbPath(),
      embedder,
      ...(opts.state ? { statePath: opts.state } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
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
  .command("backfill-facts")
  .description("One-shot: classify historical sessions and populate the FactStore (Phase B.5)")
  .option("-l, --limit <n>", "max sessions to process this run", (v) => Number.parseInt(v, 10))
  .option("--from <session-id>", "skip sessions with id <= this value (operator-resume)")
  .option("--state <path>", "resume state file (default ~/.nlm/backfill_facts.state)")
  .option("--dry-run", "count what would happen without writing facts")
  .option("--reprocess", "re-classify sessions that already have facts")
  .option("--no-embed", "skip per-fact embedding (faster but disables semantic recall)")
  .option("-v, --verbose", "per-session progress on stderr")
  .action(async (opts) => {
    const { storage, store, facts, embedder, classifier } = await buildStack();
    try {
      const report = await backfillFacts({
        // TODO(#215a): PgStorage backfill port; SQLite-only until then
        store: store as import("../core/storage/sqlite-session-store.js").SqliteSessionStore,
        factStore: facts as import("../core/storage/sqlite-fact-store.js").SqliteFactStore,
        classifier,
        embedder: opts.embed === false ? null : embedder,
        ...(opts.state ? { statePath: opts.state } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
        ...(opts.from ? { from: opts.from } : {}),
        dryRun: Boolean(opts.dryRun),
        reprocess: Boolean(opts.reprocess),
        ...(opts.verbose
          ? {
              onProgress: (i, n, sid, status, detail) => {
                const tail = detail ? `  ${detail}` : "";
                process.stderr.write(`  [${i}/${n}] ${sid}  ${status}${tail}\n`);
              },
            }
          : {}),
      });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } finally {
      await storage.close();
    }
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
    const { recall, store, facts, factRecall } = await buildStack();
    const server = createMcpServer({ recall, store, factStore: facts, factRecall });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });

const LAUNCH_AGENT_LABEL = "com.github.pbmagnet4.nlm-memory";
const LAUNCH_AGENT_PLIST = join(
  homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`,
);

const LINUX_SYSTEMD_UNIT_NAME = "nlm.service";
const LINUX_SYSTEMD_UNIT_PATH = join(
  homedir(), ".config", "systemd", "user", LINUX_SYSTEMD_UNIT_NAME,
);

function buildSystemdUnit(nodeExec: string, nlmJs: string): string {
  const logDir = join(homedir(), ".nlm", "logs");
  return `[Unit]
Description=NLM Memory — local AI session memory daemon
After=network.target

[Service]
Type=simple
ExecStart=${nodeExec} ${nlmJs} start
WorkingDirectory=${homedir()}
Restart=on-failure
RestartSec=10
StandardOutput=append:${logDir}/daemon-out.log
StandardError=append:${logDir}/daemon-err.log

[Install]
WantedBy=default.target
`;
}

// systemd user instance needs XDG_RUNTIME_DIR (a real user session) and
// systemctl --user to respond. Both are missing on headless servers without
// loginctl enable-linger and in many minimal containers.
function linuxSystemdUserAvailable(): boolean {
  if (process.platform !== "linux") return false;
  if (!process.env["XDG_RUNTIME_DIR"]) return false;
  return spawnSync("systemctl", ["--user", "--version"], { encoding: "utf8" }).status === 0;
}

function buildPlist(nodeExec: string, nlmJs: string): string {
  const logDir = join(homedir(), ".nlm", "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExec}</string>
    <string>${nlmJs}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${homedir()}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${logDir}/daemon-out.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/daemon-err.log</string>
</dict>
</plist>
`;
}

program
  .command("install")
  .description("Install the auto-start daemon (LaunchAgent on macOS, systemd user unit on Linux)")
  .action(() => {
    // Harden before installing the daemon so the persisted unit owner-
    // checks succeed against locked-down ~/.nlm logs.
    hardenNlmDirPermissions();
    if (process.platform === "darwin") {
      const uid = process.getuid?.();
      if (uid === undefined) {
        console.error("nlm install: could not determine UID");
        process.exit(1);
      }
      mkdirSync(join(homedir(), ".nlm", "logs"), { recursive: true });
      writeFileSync(LAUNCH_AGENT_PLIST, buildPlist(process.execPath, __filename), "utf8");
      console.error(`nlm: wrote ${LAUNCH_AGENT_PLIST}`);
      try {
        execFileSync("launchctl", ["bootout", `gui/${uid}`, LAUNCH_AGENT_LABEL], { stdio: "ignore" });
      } catch {
        // not loaded yet — expected on first install
      }
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, LAUNCH_AGENT_PLIST]);
      console.error("nlm: daemon installed and started.");
      console.error(`  UI:       http://localhost:${port()}/ui`);
      console.error(`  To stop:  launchctl stop ${LAUNCH_AGENT_LABEL}`);
      console.error("  To remove: nlm uninstall");
      return;
    }

    if (process.platform === "linux") {
      if (!linuxSystemdUserAvailable()) {
        console.error("nlm install: systemd user instance not available.");
        console.error("  XDG_RUNTIME_DIR missing or `systemctl --user` did not respond.");
        console.error("  Common on headless servers without an active user session.");
        console.error("  Start manually with: nlm start &");
        console.error("  Or enable lingering so user units run without login:");
        console.error("    sudo loginctl enable-linger $USER");
        console.error("  Then re-run: nlm install");
        process.exit(1);
      }
      mkdirSync(dirname(LINUX_SYSTEMD_UNIT_PATH), { recursive: true });
      mkdirSync(join(homedir(), ".nlm", "logs"), { recursive: true });
      writeFileSync(LINUX_SYSTEMD_UNIT_PATH, buildSystemdUnit(process.execPath, __filename), "utf8");
      console.error(`nlm: wrote ${LINUX_SYSTEMD_UNIT_PATH}`);
      execFileSync("systemctl", ["--user", "daemon-reload"]);
      execFileSync("systemctl", ["--user", "enable", "--now", LINUX_SYSTEMD_UNIT_NAME]);
      console.error("nlm: daemon installed and started.");
      console.error(`  UI:        http://localhost:${port()}/ui`);
      console.error(`  Status:    systemctl --user status ${LINUX_SYSTEMD_UNIT_NAME}`);
      console.error(`  To stop:   systemctl --user stop ${LINUX_SYSTEMD_UNIT_NAME}`);
      console.error("  To remove: nlm uninstall");
      console.error("  Headless? Run `sudo loginctl enable-linger $USER` so the daemon survives logout.");
      return;
    }

    console.error("nlm install: only macOS and Linux (systemd) are supported.");
    console.error("  On Windows, run `nlm start` manually or via Task Scheduler.");
    process.exit(1);
  });

program
  .command("uninstall")
  .description("Remove the auto-start daemon (LaunchAgent on macOS, systemd user unit on Linux)")
  .action(() => {
    if (process.platform === "linux") {
      // Stop + disable, then remove the unit. Idempotent: ignore "not loaded"
      // errors so re-running uninstall on a half-removed state still finishes.
      try {
        execFileSync("systemctl", ["--user", "disable", "--now", LINUX_SYSTEMD_UNIT_NAME], { stdio: "pipe" });
        console.error(`nlm: stopped and disabled ${LINUX_SYSTEMD_UNIT_NAME}`);
      } catch {
        // Unit wasn't loaded — fine, proceed to file cleanup.
      }
      if (existsSync(LINUX_SYSTEMD_UNIT_PATH)) {
        rmSync(LINUX_SYSTEMD_UNIT_PATH);
        console.error(`nlm: removed ${LINUX_SYSTEMD_UNIT_PATH}`);
      }
      try {
        execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
      } catch {
        // systemd unavailable — file already removed, nothing more to do.
      }
      console.error("nlm: uninstalled. Run `nlm install` to reinstall.");
      return;
    }

    if (process.platform !== "darwin") {
      console.error("nlm uninstall: only macOS and Linux (systemd) are supported.");
      process.exit(1);
    }
    const uid = process.getuid?.();
    if (uid === undefined) {
      console.error("nlm uninstall: could not determine UID");
      process.exit(1);
    }

    let bootoutFailed = false;
    let bootoutStderr = "";
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}`, LAUNCH_AGENT_LABEL], { stdio: "pipe" });
      console.error("nlm: daemon stopped.");
    } catch (e) {
      const err = e as { stderr?: Buffer | string };
      bootoutStderr = err.stderr ? err.stderr.toString() : "";
      if (isBenignBootoutError(bootoutStderr)) {
        // Agent wasn't loaded — fine, proceed to plist cleanup.
      } else {
        bootoutFailed = true;
      }
    }

    // Source of truth: did launchd actually unload the agent? Same shape
    // of bug as #161 — silent partial success is worse than loud failure.
    if (isAgentLoaded(LAUNCH_AGENT_LABEL)) {
      console.error("nlm: uninstall FAILED — agent is still loaded after bootout.");
      if (bootoutStderr.trim()) {
        console.error(`  launchctl stderr: ${bootoutStderr.trim()}`);
      }
      console.error("  Recovery options:");
      console.error(`    1. launchctl bootout gui/${uid}/${LAUNCH_AGENT_LABEL}`);
      console.error("    2. If a stale process is holding the port, find it:");
      console.error("       ps aux | grep 'nlm.js start' | grep -v grep");
      console.error("       Then: kill <pid>  (or  kill -9 <pid>  if it ignores TERM)");
      console.error("  Plist NOT removed — re-run `nlm uninstall` after the agent is gone.");
      process.exit(1);
    }

    if (bootoutFailed) {
      // launchctl errored AND the agent isn't loaded — odd but recoverable.
      // Flag it so the user knows something off-script happened.
      console.error(`nlm: bootout reported an error but agent is unloaded: ${bootoutStderr.trim()}`);
    }

    if (existsSync(LAUNCH_AGENT_PLIST)) {
      rmSync(LAUNCH_AGENT_PLIST);
      console.error(`nlm: removed ${LAUNCH_AGENT_PLIST}`);
    }
    console.error("nlm: uninstalled. Run `nlm install` to reinstall.");
  });

program
  .command("restart")
  .description("Restart the running daemon so a freshly-installed binary actually takes effect")
  .action(() => {
    const plan = planRestart({
      platform: process.platform,
      uid: process.getuid?.(),
      agentLoaded: process.platform === "darwin" && isAgentLoaded(LAUNCH_AGENT_LABEL),
      plistExists: existsSync(LAUNCH_AGENT_PLIST),
      systemdAvailable: linuxSystemdUserAvailable(),
      unitFileExists: existsSync(LINUX_SYSTEMD_UNIT_PATH),
      label: LAUNCH_AGENT_LABEL,
      plistPath: LAUNCH_AGENT_PLIST,
      unitName: LINUX_SYSTEMD_UNIT_NAME,
    });

    executeRestartPlan(plan, {
      successMessage: "daemon restarted with new code.",
      execFileSync,
      spawn: spawn as unknown as ExecuteRestartPlanDeps["spawn"],
      execPath: process.execPath,
      filename: __filename,
      pkillPattern: DAEMON_PKILL_PATTERN,
    });
  });

program
  .command("upgrade")
  .description("Install the latest nlm-memory from npm and restart the daemon")
  .action(() => {
    if (isDevBuild(__filename)) {
      console.error("nlm upgrade: you're running a dev build - run `npm run build` to pick up changes.");
      return;
    }

    console.error("nlm: upgrading nlm-memory…");
    try {
      execFileSync("npm", ["install", "-g", "nlm-memory@latest"], { stdio: "inherit" });
    } catch {
      // npm already printed its own error to stderr via stdio: "inherit"
      process.exit(1);
    }

    rmSync(updateCheckCachePath(), { force: true });

    const plan = planRestart({
      platform: process.platform,
      uid: process.getuid?.(),
      agentLoaded: process.platform === "darwin" && isAgentLoaded(LAUNCH_AGENT_LABEL),
      plistExists: existsSync(LAUNCH_AGENT_PLIST),
      systemdAvailable: linuxSystemdUserAvailable(),
      unitFileExists: existsSync(LINUX_SYSTEMD_UNIT_PATH),
      label: LAUNCH_AGENT_LABEL,
      plistPath: LAUNCH_AGENT_PLIST,
      unitName: LINUX_SYSTEMD_UNIT_NAME,
    });

    executeRestartPlan(plan, {
      successMessage: "upgraded and restarted.",
      execFileSync,
      spawn: spawn as unknown as ExecuteRestartPlanDeps["spawn"],
      execPath: process.execPath,
      filename: __filename,
      pkillPattern: DAEMON_PKILL_PATTERN,
    });
  });

const config = program
  .command("config")
  .description("Read and write nlm-memory settings in ~/.nlm/.env");

config
  .command("ui-auth [state]")
  .description("Show or set the WebUI auth mode (on = cookie, off = no auth)")
  .action((state?: string) => {
    autoloadEnv();
    const envPath = join(homedir(), ".nlm", ".env");
    if (state === undefined) {
      const current = process.env["NLM_UI_AUTH"] === "cookie" ? "on" : "off";
      console.error(`nlm config ui-auth: currently ${current}`);
      console.error("  on  → /ui/* and /api/* require a session cookie minted by `nlm ui`");
      console.error("  off → loopback bind is the only check (default)");
      return;
    }
    const normalized = state.toLowerCase();
    let value: string | null;
    if (normalized === "on" || normalized === "cookie") {
      value = "cookie";
    } else if (normalized === "off" || normalized === "none") {
      value = null;
    } else {
      console.error(`nlm config ui-auth: unknown state "${state}". Use "on" or "off".`);
      process.exit(1);
    }
    mkdirSync(dirname(envPath), { recursive: true });
    const before = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const after = applyEnvAssignment(before, "NLM_UI_AUTH", value);
    writeFileSync(envPath, after, { mode: 0o600 });
    console.error(`nlm config ui-auth: set to ${value === null ? "off" : "on"} in ${envPath}`);
    console.error("  Restart the daemon to pick up the change: nlm restart");
  });

program
  .command("ui")
  .description("Open the WebUI, bootstrapping a session cookie via single-use nonce")
  .option("--print", "Print the bootstrap URL to stdout instead of opening a browser (use over SSH when the daemon host is headless or you're accessing via Tailscale)")
  .action(async (opts: { print?: boolean }) => {
    // The daemon autoloads .env at startup, but a fresh shell invoking
    // `nlm ui` won't have NLM_MCP_TOKEN exported unless the user sourced
    // it manually. Mirror the daemon's lookup so this command works from
    // any shell on the same machine.
    autoloadEnv();
    const p = port();
    const token = process.env["NLM_MCP_TOKEN"];
    let target = `http://localhost:${p}/ui/`;
    if (token) {
      // Mint a single-use nonce server-side and put THAT in the URL,
      // not the long-lived token. Browser history retains the nonce
      // but the nonce dies on first use or after ~60 seconds. Replay
      // from any leaked URL fails.
      try {
        const res = await fetch(`http://localhost:${p}/api/ui-bootstrap-nonce`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          console.error(`nlm ui: daemon rejected nonce request (HTTP ${res.status}). Is NLM_MCP_TOKEN current?`);
          process.exit(1);
        }
        const { nonce } = (await res.json()) as { nonce: string };
        target = `http://localhost:${p}/ui/auth?nonce=${encodeURIComponent(nonce)}`;
      } catch (e) {
        console.error(`nlm ui: could not reach the daemon at localhost:${p}. Is it running?`);
        console.error(`  ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    }
    if (opts.print) {
      // stdout (not stderr) so the URL can be piped or captured cleanly.
      // The accompanying status line goes to stderr.
      if (token) {
        console.error(`nlm ui: paste this URL into your browser within ~60s (nonce expires):`);
      } else {
        console.error("nlm ui: visit this URL in your browser:");
      }
      process.stdout.write(`${target}\n`);
      return;
    }
    const opener = process.platform === "darwin"
      ? "open"
      : process.platform === "linux"
      ? "xdg-open"
      : null;
    if (opener) {
      try {
        execFileSync(opener, [target], { stdio: "ignore" });
        console.error(`nlm: opened the WebUI${token ? " (bootstrapping session cookie)" : ""}.`);
        return;
      } catch {
        // Fall through to print-only.
      }
    }
    console.error("nlm: could not auto-open a browser. Visit:");
    console.error(`  ${target}`);
  });

const HOOK_JS = resolve(__dirname, "../hook/prompt-recall-hook.js");
const SESSION_START_HOOK_JS = resolve(__dirname, "../hook/session-start-hook.js");
const SESSION_END_HOOK_JS = resolve(__dirname, "../hook/session-end-hook.js");
const STOP_HOOK_JS = resolve(__dirname, "../hook/stop-hook.js");
const PRE_COMPACT_HOOK_JS = resolve(__dirname, "../hook/pre-compact-hook.js");
const SUBAGENT_START_HOOK_JS = resolve(__dirname, "../hook/subagent-start-hook.js");

interface HookSpec {
  readonly event: "UserPromptSubmit" | "SessionStart" | "SessionEnd" | "Stop" | "PreCompact" | "SubagentStart";
  readonly script: string;
  readonly label: string;
}

const ALL_HOOKS: ReadonlyArray<HookSpec> = [
  { event: "UserPromptSubmit", script: HOOK_JS, label: "recall" },
  { event: "SessionStart", script: SESSION_START_HOOK_JS, label: "session-start" },
  { event: "SessionEnd", script: SESSION_END_HOOK_JS, label: "session-end" },
  { event: "Stop", script: STOP_HOOK_JS, label: "stop" },
  { event: "PreCompact", script: PRE_COMPACT_HOOK_JS, label: "pre-compact" },
  { event: "SubagentStart", script: SUBAGENT_START_HOOK_JS, label: "subagent-start" },
];

function claudeSettingsPath(): string {
  return process.env["NLM_CLAUDE_SETTINGS"] ?? join(homedir(), ".claude", "settings.json");
}

const hook = program
  .command("hook")
  .description("Manage the Claude Code NLM hooks");

hook
  .command("install")
  .description("Add the NLM hooks (recall + session-end + stop) to ~/.claude/settings.json (live mode)")
  .action(() => {
    const path = claudeSettingsPath();
    const installed: HookSpec[] = [];
    for (const spec of ALL_HOOKS) {
      const command = buildHookCommand(process.execPath, spec.script, "live");
      try {
        addHook(path, command, spec.event);
        installed.push(spec);
      } catch (e) {
        for (const prior of installed) removeHook(path, prior.event);
        console.error(`nlm: ${spec.label} hook (${spec.event}) install failed — all NLM hooks reverted.`);
        console.error(`  reason: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    }

    console.error(`nlm: NLM hooks installed in ${path} (live mode):`);
    for (const spec of installed) {
      console.error(`  - ${spec.event} → ${spec.label}-hook`);
    }
    console.error("  Recall hooks inject prior-session context on UserPromptSubmit and log to ~/.nlm/hook-log.jsonl.");
    console.error("  Session-end hook cleans up ~/.nlm/hook-state/<session>.json on session close.");
    console.error("  To run silently for calibration (no injection): set NLM_HOOK_MODE=shadow in the command.");
    console.error("  To remove: nlm hook uninstall");
  });

hook
  .command("uninstall")
  .description("Remove all NLM hooks from ~/.claude/settings.json")
  .action(() => {
    const path = claudeSettingsPath();
    removeHook(path, "*");
    console.error(`nlm: all NLM hooks removed from ${path}.`);
  });

// Repo root resolves to <pkg>/dist/cli/nlm.js → <pkg>/. The plugin tree is
// shipped alongside dist/ so plugin/scripts/ is reachable from both local
// dev and the globally-installed package.
const REPO_ROOT = resolve(__dirname, "../..");

const connect = program
  .command("connect")
  .description("Connect nlm-memory to an AI coding runtime");

connect
  .command("codex")
  .description("Install nlm-memory as a Codex CLI plugin (marketplace + plugin add)")
  .option("--source <source>", "marketplace source (owner/repo, git URL, or local path)", "pbmagnet4/nlm-memory")
  .option("--local", "shortcut for --source <repo-root>; use during dev")
  .option("--with-hooks", "additionally write absolute paths to ~/.codex/hooks.json (Codex Desktop fallback for openai/codex#16430)")
  .option("--dry-run", "print what would happen without invoking codex")
  .action((opts) => {
    if (!opts.dryRun && !codexBinaryAvailable()) {
      console.error("nlm connect codex: `codex` binary not on PATH. Install via `npm i -g @openai/codex` or `brew install codex`.");
      process.exit(1);
    }
    const source = opts.local ? REPO_ROOT : opts.source;
    const report = connectCodex(
      { source, withHooks: Boolean(opts.withHooks), dryRun: Boolean(opts.dryRun) },
      pluginScriptsDir(REPO_ROOT),
    );

    if (report.dryRun) {
      console.error("nlm connect codex (dry run):");
      console.error(`  codex plugin marketplace add ${report.source}`);
      console.error(`  codex plugin add ${report.pluginName}@${report.marketplaceName}`);
      console.error(`  write [mcp_servers.nlm-memory] block to ${report.mcpServerWritten}`);
      if (report.legacyHooksWritten) {
        console.error(`  write legacy fallback to ${report.legacyHooksWritten}`);
      }
      return;
    }

    if (report.marketplaceAdd && report.marketplaceAdd.status !== 0) {
      const stderr = report.marketplaceAdd.stderr.trim();
      console.error(`nlm connect codex: marketplace add failed (exit ${report.marketplaceAdd.status}).`);
      if (stderr) console.error(`  codex stderr: ${stderr}`);
      process.exit(1);
    }
    if (report.pluginAdd && report.pluginAdd.status !== 0) {
      const stderr = report.pluginAdd.stderr.trim();
      console.error(`nlm connect codex: plugin add failed (exit ${report.pluginAdd.status}).`);
      if (stderr) console.error(`  codex stderr: ${stderr}`);
      process.exit(1);
    }

    console.error(`nlm: connected to Codex via marketplace ${report.marketplaceName}, plugin ${report.pluginName}.`);
    if (report.mcpServerWritten) {
      console.error(`  Wrote [mcp_servers.nlm-memory] to ${report.mcpServerWritten}`);
    }
    if (report.legacyHooksWritten) {
      console.error(`  Wrote hooks.json fallback to ${report.legacyHooksWritten}`);
    }
    console.error("  Next: run `codex` interactively and approve the hook trust prompts. Then prompt — recall should fire.");
  });

connect
  .command("claude-code")
  .description("Write the nlm-memory MCP server block into ~/.mcp.json")
  .option("--with-hooks", "also install Claude Code session hooks")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    if (opts.dryRun) {
      console.error("nlm connect claude-code (dry run):");
      console.error(`  write [mcpServers.nlm-memory] to ${mcpConfigPath()}`);
      if (opts.withHooks) console.error("  install 6 Claude Code hooks");
      return;
    }
    const report = connectClaudeCode({ nlmBinPath: __filename, nodeExecPath: process.execPath });
    const action = report.alreadyPresent ? "updated" : "written";
    console.error(`nlm: [mcpServers.nlm-memory] ${action} → ${report.mcpConfigPath}`);
    console.error("  Restart Claude Code to activate the MCP server.");
    if (opts.withHooks) {
      const path = claudeSettingsPath();
      const result = installClaudeCodeHooks({
        nodeExecPath: process.execPath,
        hooks: ALL_HOOKS,
        settingsPath: path,
        addHook,
        removeHook,
        buildHookCommand,
      });
      if (!result.ok) {
        console.error(`nlm: ${result.failedLabel ?? "hook"} install failed — all hooks reverted. Run \`nlm hook install\` manually.`);
        process.exit(1);
      }
      console.error(`nlm: ${result.count} hooks installed → ${path}`);
    }
  });

connect
  .command("hermes")
  .description("Write the nlm-memory MCP server entry into ~/.hermes/config.yaml")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    if (opts.dryRun) {
      console.error(`nlm connect hermes (dry run): write [mcp_servers.nlm-memory] to ${hermesConfigPath()}`);
      return;
    }
    const report = connectHermes({ nlmBinPath: __filename, nodeExecPath: process.execPath, dryRun: false });
    const action = report.alreadyPresent ? "updated" : "written";
    console.error(`nlm: [mcp_servers.nlm-memory] ${action} → ${report.configPath}`);
    console.error("  Restart Hermes to activate the MCP server.");
  });

connect
  .command("hermes-agent")
  .description("Install the nlm-memory plugin into NousResearch Hermes Agent (~/.hermes/plugins/nlm-memory/)")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const pluginSrcDir = join(REPO_ROOT, "plugin-hermes-agent");
    if (opts.dryRun) {
      console.error(`nlm connect hermes-agent (dry run): copy ${pluginSrcDir} → ${hermesAgentPluginDir()}`);
      console.error("  then: hermes plugins enable nlm-memory");
      return;
    }
    const report = connectHermesAgent({ pluginSrcDir, dryRun: false });
    const action = report.alreadyPresent ? "updated" : "installed";
    console.error(`nlm: nlm-memory plugin ${action} → ${report.destDir}`);
    if (report.enabledViaCli) {
      console.error("  Enabled via: hermes plugins enable nlm-memory");
    } else {
      console.error("  Run: hermes plugins enable nlm-memory (if hermes binary is on PATH)");
    }
    console.error("  Also run: nlm connect hermes  (to wire the MCP server)");
  });

connect
  .command("cursor")
  .description("Register Cursor as an nlm source (reads state.vscdb directly — no files installed)")
  .option("--db-path <path>", "override path to globalStorage/state.vscdb")
  .option("--with-rules", "also install workspace rules nudge at .cursor/rules/nlm-recall.mdc")
  .option("--dry-run", "print what would happen without changing files")
  .action(async (opts) => {
    const storage = SqliteStorage.create({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    try {
      // TODO(#215a): replace storage.rawDb() with port methods
      const registry = new SourceRegistry(storage.rawDb());
      const report = connectCursor(registry, {
        ...(opts.dbPath ? { dbPath: opts.dbPath as string } : {}),
        dryRun: Boolean(opts.dryRun),
      });
      if (opts.dryRun) {
        console.error(`nlm connect cursor (dry run): register source at ${report.adapterDbPath}${report.adapterExists ? "" : " (not found yet)"}`);
        if (opts.withRules) console.error("  also install workspace rules nudge at ./.cursor/rules/nlm-recall.mdc");
        return;
      }
      const suffix = report.adapterExists ? "" : " (DB not found — will activate when Cursor is installed)";
      console.error(`nlm: Cursor source ${report.action} → ${report.adapterDbPath}${suffix}`);
      if (opts.withRules) {
        const rules = installCursorRules();
        console.error(`  ${describeUpsert("Cursor", rules)}`);
        console.error("  Note: workspace-scoped. Re-run inside each project where you want the nudge.");
      }
    } finally {
      await storage.close();
    }
  });

connect
  .command("windsurf")
  .description("Register Windsurf as an nlm source (reads state.vscdb files directly — no files installed)")
  .option("--user-dir <path>", "override path to Windsurf User directory")
  .option("--with-rules", "also install global rules nudge at ~/.codeium/windsurf/memories/global_rules.md")
  .option("--dry-run", "print what would happen without changing files")
  .action(async (opts) => {
    const storage = SqliteStorage.create({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    try {
      // TODO(#215a): replace storage.rawDb() with port methods
      const registry = new SourceRegistry(storage.rawDb());
      const report = connectWindsurf(registry, {
        ...(opts.userDir ? { userDir: opts.userDir as string } : {}),
        dryRun: Boolean(opts.dryRun),
      });
      if (opts.dryRun) {
        console.error(`nlm connect windsurf (dry run): register source at ${report.userDir}${report.dirExists ? "" : " (not found yet)"}`);
        if (opts.withRules) console.error("  also install global rules nudge at ~/.codeium/windsurf/memories/global_rules.md");
        return;
      }
      const suffix = report.dirExists ? "" : " (User dir not found — will activate when Windsurf is installed)";
      console.error(`nlm: Windsurf source ${report.action} → ${report.userDir}${suffix}`);
      if (opts.withRules) {
        const rules = installWindsurfRules();
        console.error(`  ${describeUpsert("Windsurf", rules)}`);
      }
    } finally {
      await storage.close();
    }
  });

connect
  .command("opencode")
  .description("Register OpenCode as an nlm source (reads opencode.db directly) and optionally install rules nudge")
  .option("--with-rules", "also install global rules nudge at ~/.config/opencode/AGENTS.md")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    if (opts.dryRun) {
      console.error("nlm connect opencode (dry run):");
      console.error("  OpenCode adapter is already wired via migrations/010_sources_opencode.sql — no source-registry mutation required");
      if (opts.withRules) console.error("  install global rules nudge at ~/.config/opencode/AGENTS.md");
      return;
    }
    console.error("nlm: OpenCode source already registered (see migration 010). No source-registry changes needed.");
    if (opts.withRules) {
      const rules = installOpencodeRules();
      console.error(`  ${describeUpsert("OpenCode", rules)}`);
    } else {
      console.error("  Pass --with-rules to install the recall nudge at ~/.config/opencode/AGENTS.md");
    }
  });

connect
  .command("pi")
  .description("Register the nlm-memory prompt-recall extension in ~/.pi/agent/settings.json")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const pluginDir = join(REPO_ROOT, "nlm");
    const report = connectPi({ pluginDir, dryRun: Boolean(opts.dryRun) });
    if (opts.dryRun) {
      const verb = report.alreadyPresent ? "already present in" : "append to";
      console.error(`nlm connect pi (dry run): ${verb} packages[] in ${report.settingsPath} → ${pluginDir}`);
      return;
    }
    if (report.alreadyPresent) {
      console.error(`nlm: pi extension already registered → ${report.pluginDir}`);
    } else {
      console.error(`nlm: pi extension registered → ${report.settingsPath}`);
      console.error(`  Packages entry: ${report.pluginDir}`);
    }
    console.error("  Restart pi to activate the prompt-recall hook.");
    console.error("  Set NLM_HOOK_MODE=live in ~/.nlm/.env to flip from shadow → live.");
  });

const disconnect = program
  .command("disconnect")
  .description("Disconnect nlm-memory from an AI coding runtime");

disconnect
  .command("codex")
  .description("Remove the nlm-memory plugin + marketplace from Codex")
  .option("--with-hooks", "also strip our entries from ~/.codex/hooks.json")
  .option("--dry-run", "print what would happen without invoking codex")
  .action((opts) => {
    if (!opts.dryRun && !codexBinaryAvailable()) {
      console.error("nlm disconnect codex: `codex` binary not on PATH.");
      process.exit(1);
    }
    const report = disconnectCodex({
      withHooks: Boolean(opts.withHooks),
      dryRun: Boolean(opts.dryRun),
    });

    if (report.dryRun) {
      console.error("nlm disconnect codex (dry run):");
      console.error(`  codex plugin remove ${report.pluginName}@${report.marketplaceName}`);
      console.error(`  codex plugin marketplace remove ${report.marketplaceName}`);
      console.error("  strip [mcp_servers.nlm-memory] block from ~/.codex/config.toml");
      if (opts.withHooks) console.error("  strip our entries from ~/.codex/hooks.json");
      return;
    }

    // Best-effort removal — non-zero exits from codex are reported but
    // don't abort, because partial cleanup (plugin removed, marketplace
    // already gone) is the common case for repeat invocations.
    const pluginStderr = (report.pluginRemove?.stderr ?? "").trim();
    const marketStderr = (report.marketplaceRemove?.stderr ?? "").trim();
    if (report.pluginRemove?.status !== 0 && pluginStderr) {
      console.error(`  plugin remove: ${pluginStderr}`);
    }
    if (report.marketplaceRemove?.status !== 0 && marketStderr) {
      console.error(`  marketplace remove: ${marketStderr}`);
    }
    console.error("nlm: disconnected from Codex.");
    console.error(report.mcpServerRemoved
      ? "  Stripped [mcp_servers.nlm-memory] block from ~/.codex/config.toml"
      : "  No [mcp_servers.nlm-memory] block to remove from ~/.codex/config.toml");
    if (opts.withHooks) {
      console.error(report.legacyHooksRemoved
        ? "  Stripped our entries from ~/.codex/hooks.json"
        : "  No legacy hooks to remove from ~/.codex/hooks.json");
    }
  });

disconnect
  .command("claude-code")
  .description("Remove the nlm-memory MCP server block from ~/.mcp.json")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const report = disconnectClaudeCode({ dryRun: Boolean(opts.dryRun) });
    if (opts.dryRun) {
      console.error(`nlm disconnect claude-code (dry run): strip [mcpServers.nlm-memory] from ${report.mcpConfigPath}`);
      return;
    }
    console.error(report.removed
      ? `nlm: removed [mcpServers.nlm-memory] from ${report.mcpConfigPath}`
      : `nlm: no [mcpServers.nlm-memory] entry found in ${report.mcpConfigPath}`);
  });

disconnect
  .command("hermes")
  .description("Remove the nlm-memory MCP server entry from ~/.hermes/config.yaml")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const report = disconnectHermes({ dryRun: Boolean(opts.dryRun) });
    if (opts.dryRun) {
      console.error(`nlm disconnect hermes (dry run): strip [mcp_servers.nlm-memory] from ${report.configPath}`);
      return;
    }
    console.error(report.removed
      ? `nlm: removed [mcp_servers.nlm-memory] from ${report.configPath}`
      : `nlm: no [mcp_servers.nlm-memory] entry found in ${report.configPath}`);
  });

disconnect
  .command("hermes-agent")
  .description("Remove the nlm-memory plugin from ~/.hermes/plugins/nlm-memory/")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const report = disconnectHermesAgent({ dryRun: Boolean(opts.dryRun) });
    if (opts.dryRun) {
      console.error(`nlm disconnect hermes-agent (dry run): remove ${hermesAgentPluginDir()}`);
      return;
    }
    console.error(report.removed
      ? `nlm: removed plugin directory ${report.destDir}`
      : `nlm: no plugin directory found at ${report.destDir}`);
  });

disconnect
  .command("cursor")
  .description("Disable the Cursor source in the nlm registry (leaves Cursor untouched)")
  .option("--with-rules", "also remove workspace rules nudge at .cursor/rules/nlm-recall.mdc")
  .option("--dry-run", "print what would happen without changing files")
  .action(async (opts) => {
    const storage = SqliteStorage.create({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    try {
      // TODO(#215a): replace storage.rawDb() with port methods
      const registry = new SourceRegistry(storage.rawDb());
      const report = disconnectCursor(registry, { dryRun: Boolean(opts.dryRun) });
      if (opts.dryRun) {
        console.error("nlm disconnect cursor (dry run): disable Cursor source in registry");
        if (opts.withRules) console.error("  also remove ./.cursor/rules/nlm-recall.mdc");
        return;
      }
      console.error(report.action === "disabled"
        ? "nlm: Cursor source disabled"
        : "nlm: no Cursor source found in registry");
      if (opts.withRules) {
        const rules = uninstallCursorRules();
        console.error(`  ${describeRemove("Cursor", rules)}`);
      }
    } finally {
      await storage.close();
    }
  });

disconnect
  .command("windsurf")
  .description("Disable the Windsurf source in the nlm registry (leaves Windsurf untouched)")
  .option("--with-rules", "also remove global rules nudge at ~/.codeium/windsurf/memories/global_rules.md")
  .option("--dry-run", "print what would happen without changing files")
  .action(async (opts) => {
    const storage = SqliteStorage.create({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    try {
      // TODO(#215a): replace storage.rawDb() with port methods
      const registry = new SourceRegistry(storage.rawDb());
      const report = disconnectWindsurf(registry, { dryRun: Boolean(opts.dryRun) });
      if (opts.dryRun) {
        console.error("nlm disconnect windsurf (dry run): disable Windsurf source in registry");
        if (opts.withRules) console.error("  also strip rules nudge from ~/.codeium/windsurf/memories/global_rules.md");
        return;
      }
      console.error(report.action === "disabled"
        ? "nlm: Windsurf source disabled"
        : "nlm: no Windsurf source found in registry");
      if (opts.withRules) {
        const rules = uninstallWindsurfRules();
        console.error(`  ${describeRemove("Windsurf", rules)}`);
      }
    } finally {
      await storage.close();
    }
  });

disconnect
  .command("opencode")
  .description("Strip the rules nudge from ~/.config/opencode/AGENTS.md (leaves OpenCode source registered)")
  .option("--with-rules", "remove rules nudge (default behavior — flag is for symmetry with connect)")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    if (opts.dryRun) {
      console.error("nlm disconnect opencode (dry run): strip rules nudge from ~/.config/opencode/AGENTS.md");
      return;
    }
    const rules = uninstallOpencodeRules();
    console.error(`nlm: ${describeRemove("OpenCode", rules)}`);
  });

disconnect
  .command("pi")
  .description("Remove the nlm-memory pi extension from ~/.pi/agent/settings.json")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const report = disconnectPi({ dryRun: Boolean(opts.dryRun) });
    if (opts.dryRun) {
      console.error(`nlm disconnect pi (dry run): strip nlm (and legacy plugin-pi) from packages[] in ${piSettingsPath()}`);
      return;
    }
    console.error(report.removed
      ? `nlm: pi extension removed → ${report.settingsPath}`
      : `nlm: no nlm pi extension found in ${report.settingsPath}`);
  });

program
  .command("setup")
  .description("Interactive first-run setup: detect runtimes, wire MCP + hooks, start daemon")
  .action(async () => {
    await runSetup({
      nlmBinPath: __filename,
      nodeExecPath: process.execPath,
      migrationsDir: MIGRATIONS_DIR,
      repoRoot: REPO_ROOT,
      dbPath: dbPath(),
      launchAgentLabel: LAUNCH_AGENT_LABEL,
      launchAgentPlist: LAUNCH_AGENT_PLIST,
      buildPlist,
      linuxSystemdUnitName: LINUX_SYSTEMD_UNIT_NAME,
      linuxSystemdUnitPath: LINUX_SYSTEMD_UNIT_PATH,
      buildSystemdUnit,
      linuxSystemdUserAvailable,
      claudeSettingsPath: claudeSettingsPath(),
      allHooks: ALL_HOOKS,
      addHook,
      removeHook,
      buildHookCommand,
    });
  });

program
  .command("improve")
  .description("Report known failure modes + recommended actions from captured signals")
  .option("--days <n>", "trailing window in days (default 14)", (v) => Number.parseInt(v, 10), 14)
  .action(async (opts) => {
    const storage = await buildStorage(dbPath());
    const scope = installScope();
    const sinceTs = new Date(Date.now() - opts.days * 86_400_000).toISOString();
    const rows = await storage.signals.listForAggregation({ installScope: scope, sinceTs });
    const { aggregateFailureModes } = await import("../core/signals/aggregate.js");
    const { recommendActions } = await import("../core/signals/recommend.js");
    const modes = aggregateFailureModes(rows);
    if (modes.length === 0) {
      console.error(`nlm improve: no failure modes above threshold in the last ${opts.days}d (${rows.length} signals).`);
      await storage.close();
      return;
    }
    console.error(`Failure modes (last ${opts.days}d, ${rows.length} signals):`);
    for (const m of modes) {
      console.error(`  ${m.model} ${m.repo} ${m.kind}/${m.step ?? "-"}: ${Math.round(m.failRate * 100)}% of ${m.total}`);
    }
    console.error("\nRecommendations:");
    for (const r of recommendActions(modes)) console.error(`  [${r.kind}] ${r.text}`);
    await storage.close();
  });

program
  .command("digest")
  .description("Compose a daily-activity digest from the running daemon (optionally post to Telegram)")
  .option("-p, --port <n>", "daemon port", (v) => Number.parseInt(v, 10), Number.parseInt(process.env["NLM_PORT"] ?? "3940", 10))
  .option("--telegram", "post to Telegram instead of printing to stdout (requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)")
  .action(async (opts) => {
    autoloadEnv();
    try {
      const result = await runDigest({
        port: opts.port as number,
        telegram: opts.telegram === true,
      });
      if (!result.daemonReachable) {
        process.exit(1);
      }
    } catch (e) {
      console.error("nlm digest:", e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program.parseAsync().catch((e) => {
  console.error("nlm: fatal", e);
  process.exit(1);
});
