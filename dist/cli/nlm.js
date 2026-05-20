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
 *   nlm install  — install the macOS LaunchAgent (auto-start on login)
 *   nlm uninstall — remove the macOS LaunchAgent
 *   nlm hook install   — add the recall hook to Claude Code (shadow mode)
 *   nlm hook uninstall — remove the recall hook from Claude Code
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { serve } from "@hono/node-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FactRecallService } from "../core/recall-facts/fact-recall-service.js";
import { RecallService } from "../core/recall/recall-service.js";
import { SqliteFactStore } from "../core/storage/sqlite-fact-store.js";
import { ProviderRegistry } from "../core/providers/provider-registry.js";
import { SourceRegistry } from "../core/sources/source-registry.js";
import { SqliteSessionStore } from "../core/storage/sqlite-session-store.js";
import { applyPendingRestore } from "../core/storage/db-restore.js";
import { createApp } from "../http/app.js";
import { createMcpServer } from "../mcp/server.js";
import { ClassifierBox } from "../llm/classifier-box.js";
import { DeepSeekClient } from "../llm/deepseek-client.js";
import { OllamaClient } from "../llm/ollama-client.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { addHook, removeHook } from "../core/hook/claude-settings.js";
import { runParity } from "./classify-parity.js";
import { reembedCorpus } from "../core/embedding/embed-backfill.js";
import { backfillFacts } from "../core/facts/backfill-facts.js";
import { normalizeEmbeddings } from "../core/embedding/embed-normalize.js";
import { ScanScheduler } from "../core/scheduler/scheduler.js";
import { adapterFromSource } from "../core/adapters/from-source.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const UI_DIST = resolve(__dirname, "../../dist/ui");
const DEFAULT_DB_PATH = resolve(homedir(), ".nlm/canonical.sqlite");
const DEFAULT_PORT = 3940;
function dbPath() {
    return process.env["NLM_DB_PATH"] ?? DEFAULT_DB_PATH;
}
function port() {
    const raw = process.env["NLM_PORT"];
    if (!raw)
        return DEFAULT_PORT;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65_535)
        return DEFAULT_PORT;
    return n;
}
function ollamaUrl() {
    return process.env["NLM_OLLAMA_URL"] ?? "http://localhost:11434";
}
function buildClassifier() {
    // DeepSeek V4 Flash is the default for the ingest classifier per the
    // 2026-05-19 parity run: ~5s/session, 90% first-try success vs Ollama
    // phi4-mini's 0% on the same first three sessions. Override with
    // NLM_CLASSIFIER=ollama if you need offline-only operation.
    const provider = (process.env["NLM_CLASSIFIER"] ?? "deepseek").toLowerCase();
    if (provider !== "ollama")
        autoloadEnv();
    const model = process.env["NLM_CLASSIFIER_MODEL"]
        ?? (provider === "ollama" ? "phi4-mini:latest" : "deepseek-v4-flash");
    return new ClassifierBox({ provider, model, ollamaUrl: ollamaUrl() });
}
function buildAdapters(sources) {
    // Sources table is the source of truth. Each enabled row maps to one
    // adapter via adapterFromSource(). Detection still gates registration —
    // a row pointing at a missing dir won't poll. NLM_ADAPTERS keeps working
    // as a name-based filter for forcing a subset during dev.
    const explicit = process.env["NLM_ADAPTERS"];
    const allowed = explicit ? new Set(explicit.split(",").map((s) => s.trim())) : null;
    const out = [];
    for (const row of sources.list()) {
        if (!row.enabled)
            continue;
        const adapter = adapterFromSource(row);
        if (!adapter)
            continue;
        if (allowed && !allowed.has(adapter.name))
            continue;
        if (!adapter.detect().enabled)
            continue;
        out.push(adapter);
    }
    return out;
}
function buildStack() {
    // Load .env before any registry seeds so secrets carried in env vars
    // (DEEPSEEK_API_KEY today; OPENAI_API_KEY etc. tomorrow) bridge into
    // the providers table on first boot under launchd.
    autoloadEnv();
    // A restore staged via POST /api/data/restore is promoted here, before
    // the store opens — the daemon can't swap a DB file it already holds.
    const restored = applyPendingRestore(dbPath());
    if (restored.applied) {
        console.error(`nlm-memory: restored database from staged backup`);
        if (restored.archivedTo)
            console.error(`  previous db archived at ${restored.archivedTo}`);
    }
    const store = new SqliteSessionStore({
        dbPath: dbPath(),
        migrationsDir: MIGRATIONS_DIR,
    });
    // FactStore shares the SessionStore's connection so session+facts ingest
    // can commit in one transaction. Phase B.1 wires it in; no callers yet.
    const facts = new SqliteFactStore(store.rawDb());
    const sources = new SourceRegistry(store.rawDb());
    sources.seedDefaults();
    const providers = new ProviderRegistry(store.rawDb());
    providers.seedDefaults();
    // Recall only uses embed(). Embeddings live on Ollama; DeepSeek doesn't
    // expose them. Classifier is wired separately for Phase D ingest.
    const embedder = new OllamaClient({ baseUrl: ollamaUrl() });
    const classifier = buildClassifier();
    const recall = new RecallService({ store, llm: embedder });
    const factRecall = new FactRecallService({ factStore: facts, llm: embedder });
    return { store, facts, sources, providers, recall, factRecall, embedder, classifier };
}
const program = new Command();
program
    .name("nlm")
    .description("Local-first memory operating system for AI operators")
    .version("0.2.0-dev");
program
    .command("start")
    .description("Boot the HTTP server + ingest scheduler")
    .option("--no-scheduler", "HTTP only; skip the ingest tick loop")
    .option("--interval-min <n>", "scheduler tick interval (min, default 30)", (v) => Number.parseInt(v, 10), 30)
    .action(async (opts) => {
    const { store, facts, sources, providers, recall, factRecall, embedder, classifier } = buildStack();
    const { existsSync } = await import("node:fs");
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
        ingest: { classifier, embedder, store, factStore: facts },
        embedderInfo: { provider: "ollama", model: "nomic-embed-text", dims: 768 },
        ...(existsSync(UI_DIST) ? { uiDist: UI_DIST } : {}),
    });
    const p = port();
    serve({ fetch: app.fetch, port: p }, (info) => {
        console.error(`nlm-memory http listening on http://localhost:${info.port}`);
        console.error(`  db:     ${dbPath()}`);
        console.error(`  ollama: ${ollamaUrl()}`);
    });
    // Keep the SQLite WAL bounded. WAL mode is on but nothing else
    // checkpoints it; under continuous readers it grows without limit
    // (it had reached 38 MB), which slows every read. Drain once at boot,
    // then every 5 minutes.
    const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60_000;
    try {
        store.checkpoint();
    }
    catch {
        // Boot checkpoint can lose a race with readers — the interval retries.
    }
    const checkpointTimer = setInterval(() => {
        try {
            store.checkpoint();
        }
        catch {
            // Checkpoint contention — the next tick retries.
        }
    }, WAL_CHECKPOINT_INTERVAL_MS);
    checkpointTimer.unref();
    if (opts.scheduler !== false) {
        const adapters = buildAdapters(sources);
        if (adapters.length === 0) {
            console.error("  scheduler: no adapters detected (set NLM_ADAPTERS to force-enable)");
        }
        else {
            const scheduler = new ScanScheduler({
                store,
                adapters,
                classifier,
                embedder,
                factStore: facts,
                intervalMs: opts.intervalMin * 60_000,
            });
            scheduler.start();
            console.error(`  scheduler: ${adapters.map((a) => a.name).join(", ")} every ${opts.intervalMin}m`);
            const shutdown = () => {
                clearInterval(checkpointTimer);
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
    }
    finally {
        store.close();
    }
});
program
    .command("classify-parity")
    .description("Run TS classifier against ~/.nlm/canonical.sqlite and diff vs persisted Python output")
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
    .option("--state <path>", "resume state file (default ~/.nlm/embed_reembed.state)")
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
                onProgress: (i, n, sid, status) => {
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
    const { store, facts, embedder, classifier } = buildStack();
    try {
        const report = await backfillFacts({
            store,
            factStore: facts,
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
    }
    finally {
        store.close();
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
    const { recall, store, facts, factRecall } = buildStack();
    const server = createMcpServer({ recall, store, factStore: facts, factRecall });
    const transport = new StdioServerTransport();
    await server.connect(transport);
});
const LAUNCH_AGENT_LABEL = "com.github.pbmagnet4.nlm-memory";
const LAUNCH_AGENT_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
function buildPlist(nodeExec, nlmJs) {
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
    .description("Install the macOS LaunchAgent so nlm-memory auto-starts on login")
    .action(() => {
    if (process.platform !== "darwin") {
        console.error("nlm install: only macOS is supported. On Linux, add `nlm start` to your init system manually.");
        process.exit(1);
    }
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
    }
    catch {
        // not loaded yet — expected on first install
    }
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, LAUNCH_AGENT_PLIST]);
    console.error("nlm: daemon installed and started.");
    console.error(`  UI:       http://localhost:${port()}/ui`);
    console.error(`  To stop:  launchctl stop ${LAUNCH_AGENT_LABEL}`);
    console.error("  To remove: nlm uninstall");
});
program
    .command("uninstall")
    .description("Remove the macOS LaunchAgent")
    .action(() => {
    if (process.platform !== "darwin") {
        console.error("nlm uninstall: only macOS is supported.");
        process.exit(1);
    }
    const uid = process.getuid?.();
    if (uid === undefined) {
        console.error("nlm uninstall: could not determine UID");
        process.exit(1);
    }
    try {
        execFileSync("launchctl", ["bootout", `gui/${uid}`, LAUNCH_AGENT_LABEL], { stdio: "pipe" });
        console.error("nlm: daemon stopped.");
    }
    catch {
        // wasn't running
    }
    if (existsSync(LAUNCH_AGENT_PLIST)) {
        rmSync(LAUNCH_AGENT_PLIST);
        console.error(`nlm: removed ${LAUNCH_AGENT_PLIST}`);
    }
    console.error("nlm: uninstalled. Run `nlm install` to reinstall.");
});
const HOOK_JS = resolve(__dirname, "../hook/prompt-recall-hook.js");
function claudeSettingsPath() {
    return process.env["NLM_CLAUDE_SETTINGS"] ?? join(homedir(), ".claude", "settings.json");
}
const hook = program
    .command("hook")
    .description("Manage the Claude Code recall hook");
hook
    .command("install")
    .description("Add the recall hook to ~/.claude/settings.json (shadow mode)")
    .action(() => {
    const path = claudeSettingsPath();
    const command = `NLM_HOOK_MODE=shadow node ${HOOK_JS}`;
    addHook(path, command);
    console.error(`nlm: recall hook installed in ${path} (shadow mode).`);
    console.error("  It logs to ~/.nlm/hook-log.jsonl and injects nothing.");
    console.error("  To go live later: change NLM_HOOK_MODE=shadow to live in that file.");
    console.error("  To remove: nlm hook uninstall");
});
hook
    .command("uninstall")
    .description("Remove the recall hook from ~/.claude/settings.json")
    .action(() => {
    const path = claudeSettingsPath();
    removeHook(path);
    console.error(`nlm: recall hook removed from ${path}.`);
});
program.parseAsync().catch((e) => {
    console.error("nlm: fatal", e);
    process.exit(1);
});
//# sourceMappingURL=nlm.js.map