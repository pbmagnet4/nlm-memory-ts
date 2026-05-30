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
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
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
import { addHook, buildHookCommand, removeHook } from "../core/hook/claude-settings.js";
import { codexBinaryAvailable, connectCodex, disconnectCodex, pluginScriptsDir, } from "../install/codex.js";
import { connectClaudeCode, disconnectClaudeCode, installClaudeCodeHooks, mcpConfigPath } from "../install/claude-code.js";
import { hardenNlmDirPermissions } from "../install/nlm-dir-perms.js";
import { ensureMcpToken } from "../install/ollama.js";
import { connectCursor, disconnectCursor } from "../install/cursor.js";
import { runSupersedeCommand } from "./supersede.js";
import { getUpdateStatus } from "../core/update-check/check.js";
import { connectHermes, disconnectHermes, hermesConfigPath } from "../install/hermes.js";
import { connectHermesAgent, disconnectHermesAgent, hermesAgentPluginDir } from "../install/hermes-agent.js";
import { connectWindsurf, disconnectWindsurf } from "../install/windsurf.js";
import { runSetup } from "../install/setup.js";
import { runParity } from "./classify-parity.js";
import { reembedCorpus } from "../core/embedding/embed-backfill.js";
import { backfillFacts } from "../core/facts/backfill-facts.js";
import { normalizeEmbeddings } from "../core/embedding/embed-normalize.js";
import { ScanScheduler } from "../core/scheduler/scheduler.js";
import { MemoSweepScheduler } from "../core/hook/memo-sweep.js";
import { isAgentLoaded, isBenignBootoutError } from "./launchctl-helpers.js";
import { DAEMON_PKILL_PATTERN, planRestart } from "./restart-helpers.js";
import { adapterFromSource } from "../core/adapters/from-source.js";
import { scanUsefulHits } from "../core/recall/useful-scan.js";
import { runDigest } from "./digest.js";
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
    const { store, facts, sources, providers, recall, factRecall, embedder, classifier } = buildStack();
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
        ingest: { classifier, embedder, store, factStore: facts },
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
                console.error(`  update: ${status.current} → ${status.latest} available (npm i -g nlm-memory@latest)`);
            }
        });
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
    // Memo sweep runs independently of the transcript scheduler — it's the
    // backstop for SessionEnd hook unreliability (crashes, kill -9, IDE
    // force-close don't fire SessionEnd, so memo files would otherwise
    // accumulate forever). Always on, even when --no-scheduler.
    const memoSweep = new MemoSweepScheduler();
    memoSweep.start();
    console.error("  memo sweep: dormant cleanup every 5m (threshold 24h)");
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
                memoSweep.stop();
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
const LINUX_SYSTEMD_UNIT_NAME = "nlm.service";
const LINUX_SYSTEMD_UNIT_PATH = join(homedir(), ".config", "systemd", "user", LINUX_SYSTEMD_UNIT_NAME);
function buildSystemdUnit(nodeExec, nlmJs) {
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
function linuxSystemdUserAvailable() {
    if (process.platform !== "linux")
        return false;
    if (!process.env["XDG_RUNTIME_DIR"])
        return false;
    return spawnSync("systemctl", ["--user", "--version"], { encoding: "utf8" }).status === 0;
}
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
        }
        catch {
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
        }
        catch {
            // Unit wasn't loaded — fine, proceed to file cleanup.
        }
        if (existsSync(LINUX_SYSTEMD_UNIT_PATH)) {
            rmSync(LINUX_SYSTEMD_UNIT_PATH);
            console.error(`nlm: removed ${LINUX_SYSTEMD_UNIT_PATH}`);
        }
        try {
            execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
        }
        catch {
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
    }
    catch (e) {
        const err = e;
        bootoutStderr = err.stderr ? err.stderr.toString() : "";
        if (isBenignBootoutError(bootoutStderr)) {
            // Agent wasn't loaded — fine, proceed to plist cleanup.
        }
        else {
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
    switch (plan.kind) {
        case "launchctl-kickstart":
            execFileSync("launchctl", ["kickstart", "-k", `gui/${plan.uid}/${plan.label}`]);
            console.error(`nlm: kicked ${plan.label} — daemon restarted with new code.`);
            return;
        case "launchctl-bootstrap":
            execFileSync("launchctl", ["bootstrap", `gui/${plan.uid}`, plan.plist]);
            console.error("nlm: agent was not loaded — bootstrapped and started.");
            return;
        case "systemctl-restart":
            execFileSync("systemctl", ["--user", "restart", plan.unit]);
            console.error(`nlm: restarted ${plan.unit}.`);
            return;
        case "pkill-respawn":
            try {
                // Pattern matches the daemon entry point specifically. A naive
                // "nlm.*start" would also match this `nlm restart` invocation and
                // kill the process running pkill before it can spawn a replacement.
                execFileSync("pkill", ["-f", DAEMON_PKILL_PATTERN], { stdio: "ignore" });
            }
            catch {
                // No matching process — fine, we'll just start a fresh one.
            }
            spawn(process.execPath, [__filename, "start"], {
                detached: true,
                stdio: "ignore",
            }).unref();
            console.error("nlm: no managed unit found — killed any running daemon and spawned a fresh one.");
            return;
        case "unsupported":
            console.error(`nlm restart: ${plan.reason}`);
            console.error("  Supported: macOS (LaunchAgent) and Linux (systemd user).");
            process.exit(1);
    }
});
program
    .command("ui")
    .description("Open the WebUI, bootstrapping a session cookie from NLM_MCP_TOKEN")
    .action(() => {
    // The daemon autoloads .env at startup, but a fresh shell invoking
    // `nlm ui` won't have NLM_MCP_TOKEN exported unless the user sourced
    // it manually. Mirror the daemon's lookup so this command works from
    // any shell on the same machine.
    autoloadEnv();
    const p = port();
    const token = process.env["NLM_MCP_TOKEN"];
    const target = token
        ? `http://localhost:${p}/ui/auth?t=${encodeURIComponent(token)}`
        : `http://localhost:${p}/ui/`;
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
        }
        catch {
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
const ALL_HOOKS = [
    { event: "UserPromptSubmit", script: HOOK_JS, label: "recall" },
    { event: "SessionStart", script: SESSION_START_HOOK_JS, label: "session-start" },
    { event: "SessionEnd", script: SESSION_END_HOOK_JS, label: "session-end" },
    { event: "Stop", script: STOP_HOOK_JS, label: "stop" },
    { event: "PreCompact", script: PRE_COMPACT_HOOK_JS, label: "pre-compact" },
    { event: "SubagentStart", script: SUBAGENT_START_HOOK_JS, label: "subagent-start" },
];
function claudeSettingsPath() {
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
    const installed = [];
    for (const spec of ALL_HOOKS) {
        const command = buildHookCommand(process.execPath, spec.script, "live");
        try {
            addHook(path, command, spec.event);
            installed.push(spec);
        }
        catch (e) {
            for (const prior of installed)
                removeHook(path, prior.event);
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
    .option("--source <source>", "marketplace source (owner/repo, git URL, or local path)", "pbmagnet4/nlm-memory-ts")
    .option("--local", "shortcut for --source <repo-root>; use during dev")
    .option("--with-hooks", "additionally write absolute paths to ~/.codex/hooks.json (Codex Desktop fallback for openai/codex#16430)")
    .option("--dry-run", "print what would happen without invoking codex")
    .action((opts) => {
    if (!opts.dryRun && !codexBinaryAvailable()) {
        console.error("nlm connect codex: `codex` binary not on PATH. Install via `npm i -g @openai/codex` or `brew install codex`.");
        process.exit(1);
    }
    const source = opts.local ? REPO_ROOT : opts.source;
    const report = connectCodex({ source, withHooks: Boolean(opts.withHooks), dryRun: Boolean(opts.dryRun) }, pluginScriptsDir(REPO_ROOT));
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
        if (stderr)
            console.error(`  codex stderr: ${stderr}`);
        process.exit(1);
    }
    if (report.pluginAdd && report.pluginAdd.status !== 0) {
        const stderr = report.pluginAdd.stderr.trim();
        console.error(`nlm connect codex: plugin add failed (exit ${report.pluginAdd.status}).`);
        if (stderr)
            console.error(`  codex stderr: ${stderr}`);
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
        if (opts.withHooks)
            console.error("  install 6 Claude Code hooks");
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
    }
    else {
        console.error("  Run: hermes plugins enable nlm-memory (if hermes binary is on PATH)");
    }
    console.error("  Also run: nlm connect hermes  (to wire the MCP server)");
});
connect
    .command("cursor")
    .description("Register Cursor as an nlm source (reads state.vscdb directly — no files installed)")
    .option("--db-path <path>", "override path to globalStorage/state.vscdb")
    .option("--dry-run", "print what would happen without changing files")
    .action((opts) => {
    const store = new SqliteSessionStore({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    try {
        const registry = new SourceRegistry(store.rawDb());
        const report = connectCursor(registry, {
            ...(opts.dbPath ? { dbPath: opts.dbPath } : {}),
            dryRun: Boolean(opts.dryRun),
        });
        if (opts.dryRun) {
            console.error(`nlm connect cursor (dry run): register source at ${report.adapterDbPath}${report.adapterExists ? "" : " (not found yet)"}`);
            return;
        }
        const suffix = report.adapterExists ? "" : " (DB not found — will activate when Cursor is installed)";
        console.error(`nlm: Cursor source ${report.action} → ${report.adapterDbPath}${suffix}`);
    }
    finally {
        store.close();
    }
});
connect
    .command("windsurf")
    .description("Register Windsurf as an nlm source (reads state.vscdb files directly — no files installed)")
    .option("--user-dir <path>", "override path to Windsurf User directory")
    .option("--dry-run", "print what would happen without changing files")
    .action((opts) => {
    const store = new SqliteSessionStore({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    try {
        const registry = new SourceRegistry(store.rawDb());
        const report = connectWindsurf(registry, {
            ...(opts.userDir ? { userDir: opts.userDir } : {}),
            dryRun: Boolean(opts.dryRun),
        });
        if (opts.dryRun) {
            console.error(`nlm connect windsurf (dry run): register source at ${report.userDir}${report.dirExists ? "" : " (not found yet)"}`);
            return;
        }
        const suffix = report.dirExists ? "" : " (User dir not found — will activate when Windsurf is installed)";
        console.error(`nlm: Windsurf source ${report.action} → ${report.userDir}${suffix}`);
    }
    finally {
        store.close();
    }
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
        if (opts.withHooks)
            console.error("  strip our entries from ~/.codex/hooks.json");
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
    .option("--dry-run", "print what would happen without changing files")
    .action((opts) => {
    const store = new SqliteSessionStore({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    try {
        const registry = new SourceRegistry(store.rawDb());
        const report = disconnectCursor(registry, { dryRun: Boolean(opts.dryRun) });
        if (opts.dryRun) {
            console.error("nlm disconnect cursor (dry run): disable Cursor source in registry");
            return;
        }
        console.error(report.action === "disabled"
            ? "nlm: Cursor source disabled"
            : "nlm: no Cursor source found in registry");
    }
    finally {
        store.close();
    }
});
disconnect
    .command("windsurf")
    .description("Disable the Windsurf source in the nlm registry (leaves Windsurf untouched)")
    .option("--dry-run", "print what would happen without changing files")
    .action((opts) => {
    const store = new SqliteSessionStore({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    try {
        const registry = new SourceRegistry(store.rawDb());
        const report = disconnectWindsurf(registry, { dryRun: Boolean(opts.dryRun) });
        if (opts.dryRun) {
            console.error("nlm disconnect windsurf (dry run): disable Windsurf source in registry");
            return;
        }
        console.error(report.action === "disabled"
            ? "nlm: Windsurf source disabled"
            : "nlm: no Windsurf source found in registry");
    }
    finally {
        store.close();
    }
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
    .command("useful-scan")
    .description("Scan hook log for useful recall hits; writes to ~/.nlm/useful-hit-log.jsonl")
    .option("-d, --days <n>", "rolling window in days", (v) => Number.parseInt(v, 10), 1)
    .option("--dry-run", "compute without writing to disk")
    .action(async (opts) => {
    const result = await scanUsefulHits({ days: opts.days, ...(opts.dryRun ? { dryRun: true } : {}) });
    const rate = result.measurable === 0
        ? "no measurable entries"
        : `${result.useful}/${result.measurable} useful (${Math.round((result.useful / result.measurable) * 100)}%)`;
    console.error(`nlm useful-scan: scanned ${result.total} recalls in the last ${opts.days}d — ${rate}` +
        (opts.dryRun ? " (dry-run)" : `, ${result.appended} appended`));
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
            port: opts.port,
            telegram: opts.telegram === true,
        });
        if (!result.daemonReachable) {
            process.exit(1);
        }
    }
    catch (e) {
        console.error("nlm digest:", e instanceof Error ? e.message : e);
        process.exit(1);
    }
});
program.parseAsync().catch((e) => {
    console.error("nlm: fatal", e);
    process.exit(1);
});
//# sourceMappingURL=nlm.js.map