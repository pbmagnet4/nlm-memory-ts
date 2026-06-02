/**
 * `nlm setup` — interactive first-run wizard.
 *
 * Step order:
 *   1. Select runtimes
 *   2. Ollama preflight (install → start server → pull embedding model)
 *   3. Classifier API key
 *   4. DB migrations
 *   5. Daemon (LaunchAgent on macOS / systemd hint on Linux / Task Scheduler hint on Windows)
 *   6. Per-runtime MCP + hook wiring
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import {
  cancel, confirm, intro, isCancel, log, multiselect, outro, password, select, spinner,
} from "@clack/prompts";
import { connectClaudeCode } from "./claude-code.js";
import { connectHermes } from "./hermes.js";
import { codexBinaryAvailable, connectCodex, pluginScriptsDir } from "./codex.js";
import { connectPi } from "./pi.js";
import { defaultDbPath as openCodeDefaultDbPath } from "../core/adapters/opencode.js";
import type { ClaudeHookEvent } from "../core/hook/claude-settings.js";
import {
  type ClassifierChoice,
  EMBEDDING_MODEL,
  embeddingModelPresent,
  ensureMcpToken,
  installOllama,
  ollamaBinaryAvailable,
  ollamaServerRunning,
  pullEmbeddingModel,
  startOllamaServer,
  waitForOllamaServer,
  writeClassifierConfig,
} from "./ollama.js";
import { installClaudeCodeHooks } from "./claude-code.js";
import { hardenNlmDirPermissions } from "./nlm-dir-perms.js";

const OS = platform();

export interface SetupOptions {
  readonly nlmBinPath: string;
  readonly nodeExecPath: string;
  readonly migrationsDir: string;
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly launchAgentLabel: string;
  readonly launchAgentPlist: string;
  readonly buildPlist: (nodeExec: string, binPath: string) => string;
  readonly linuxSystemdUnitName: string;
  readonly linuxSystemdUnitPath: string;
  readonly buildSystemdUnit: (nodeExec: string, binPath: string) => string;
  readonly linuxSystemdUserAvailable: () => boolean;
  readonly claudeSettingsPath: string;
  readonly allHooks: ReadonlyArray<{
    event: ClaudeHookEvent;
    script: string;
    label: string;
  }>;
  readonly addHook: (path: string, command: string, event?: ClaudeHookEvent) => void;
  readonly removeHook: (path: string, event?: ClaudeHookEvent | "*") => void;
  readonly buildHookCommand: (nodeExec: string, script: string, mode: "shadow" | "live") => string;
}

// Embedding-only tags shouldn't be offered as classifier models — they
// can't run chat completions and the call would fail at first ingest.
const EMBEDDING_MODEL_PREFIXES = ["nomic-embed", "mxbai-embed", "snowflake-arctic-embed", "bge-"] as const;

async function fetchOllamaChatModels(timeoutMs = 5000): Promise<string[]> {
  const baseUrl = process.env["NLM_OLLAMA_URL"] ?? "http://localhost:11434";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string")
      .filter((n) => !EMBEDDING_MODEL_PREFIXES.some((p) => n.startsWith(p)))
      .sort();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

type RuntimeId = "claude-code" | "codex" | "opencode" | "hermes" | "pi";

interface RuntimeOption {
  readonly id: RuntimeId;
  readonly label: string;
  readonly hint: string;
  readonly detected: boolean;
}

function detectRuntimes(): RuntimeOption[] {
  const claudeProjectsPath = process.env["NLM_CLAUDE_PROJECTS_PATH"]
    ?? join(homedir(), ".claude", "projects");
  const hermesPath = process.env["NLM_HERMES_SESSIONS_PATH"]
    ?? join(homedir(), ".hermes", "sessions");
  const piPath = process.env["PI_SESSIONS_PATH"]
    ?? join(homedir(), ".pi", "agent", "sessions");
  const openCodeDb = openCodeDefaultDbPath();

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      hint: existsSync(claudeProjectsPath) ? "detected" : "not found",
      detected: existsSync(claudeProjectsPath),
    },
    {
      id: "codex",
      label: "Codex (OpenAI)",
      hint: codexBinaryAvailable() ? "detected" : "not found — install: npm i -g @openai/codex",
      detected: codexBinaryAvailable(),
    },
    {
      id: "opencode",
      label: "OpenCode (sst)",
      hint: existsSync(openCodeDb) ? "detected" : "not found",
      detected: existsSync(openCodeDb),
    },
    {
      id: "hermes",
      label: "Hermes",
      hint: existsSync(hermesPath) ? "detected" : "not found",
      detected: existsSync(hermesPath),
    },
    {
      id: "pi",
      label: "pi.dev",
      hint: existsSync(piPath) ? "detected" : "not found",
      detected: existsSync(piPath),
    },
  ];
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  intro("NLM Memory — first-run setup");

  // ── Step 1: runtime selection ─────────────────────────────────────────
  const runtimes = detectRuntimes();
  const detectedIds = runtimes.filter((r) => r.detected).map((r) => r.id);

  const selected = await multiselect<RuntimeId>({
    message: "Which AI coding runtimes do you use?",
    options: runtimes.map((r) => ({ value: r.id, label: r.label, hint: r.hint })),
    initialValues: detectedIds,
    required: false,
  });
  if (isCancel(selected)) { cancel("Setup cancelled."); process.exit(0); }
  const chosen = selected as RuntimeId[];

  // ── Step 2: Ollama preflight ──────────────────────────────────────────
  if (!ollamaBinaryAvailable()) {
    const installMsg = OS === "linux"
      ? "Ollama not found. Install now? (runs the official install.sh as current user — see https://ollama.com/install.sh)"
      : "Ollama not found. Install it now? (required for memory indexing)";
    const doInstall = await confirm({ message: installMsg });
    if (isCancel(doInstall)) { cancel("Setup cancelled."); process.exit(0); }

    if (doInstall) {
      const is = spinner();
      is.start("Installing Ollama");
      const result = installOllama();
      if (result.ok) {
        is.stop("Ollama installed");
      } else {
        is.stop("Ollama install failed");
        log.warn(result.output);
        log.warn("Install Ollama manually from https://ollama.com/download, then re-run `nlm setup`.");
      }
    } else {
      log.warn("Skipping Ollama install — memory indexing won't work until Ollama is running with nomic-embed-text.");
    }
  }

  // Ensure server is running before attempting pull.
  if (ollamaBinaryAvailable() && !ollamaServerRunning()) {
    const ss = spinner();
    ss.start("Starting Ollama server");
    const result = startOllamaServer();
    if (result.ok) {
      ss.start("Waiting for Ollama server to accept connections");
      const ready = await waitForOllamaServer(15, 1000);
      if (ready) {
        ss.stop("Ollama server ready");
      } else {
        ss.stop("Ollama server started but not responding yet");
        log.warn("If the model pull fails, wait a moment and run `ollama pull nomic-embed-text` manually.");
      }
    } else {
      ss.stop("Could not start Ollama server automatically");
      log.warn(`Start it manually with \`ollama serve\`, then re-run \`nlm setup\`. (${result.output})`);
    }
  }

  if (ollamaBinaryAvailable() && !embeddingModelPresent()) {
    const doPull = await confirm({ message: `Pull the ${EMBEDDING_MODEL} embedding model now? (~274 MB, required for semantic recall)` });
    if (isCancel(doPull)) { cancel("Setup cancelled."); process.exit(0); }

    if (doPull) {
      const ps = spinner();
      ps.start(`Pulling ${EMBEDDING_MODEL} (this may take a few minutes)`);
      const result = pullEmbeddingModel();
      if (result.ok) {
        ps.stop(`${EMBEDDING_MODEL} ready`);
      } else {
        ps.stop("Model pull failed");
        log.warn(`Run \`ollama pull ${EMBEDDING_MODEL}\` manually to retry.`);
      }
    } else {
      log.warn(`Skipping model pull — run \`ollama pull ${EMBEDDING_MODEL}\` before using memory recall.`);
    }
  }

  if (ollamaBinaryAvailable() && embeddingModelPresent()) {
    log.success(`Ollama ready — ${EMBEDDING_MODEL} present`);
  }

  // ── Step 3: classifier (provider + model + key) ───────────────────────
  const wantConfigure = await confirm({
    message: "Configure the session classifier? (controls how new sessions are tagged)",
  });
  if (isCancel(wantConfigure)) { cancel("Setup cancelled."); process.exit(0); }

  if (wantConfigure) {
    const classifierChoice = await select<ClassifierChoice>({
      message: "Which classifier provider?",
      options: [
        {
          value: "ollama-offline",
          label: "Ollama (local) — recommended",
          hint: "private — runs on this machine via your local Ollama. Nothing leaves the host. Slower; needs a chat model pulled.",
        },
        {
          value: "deepseek",
          label: "DeepSeek (cloud)",
          hint: "fast, cheap (~$0.002/session). Transcripts are sent to api.deepseek.com.",
        },
      ],
    });
    if (isCancel(classifierChoice)) { cancel("Setup cancelled."); process.exit(0); }

    if (classifierChoice === "deepseek") {
      log.info("Heads up: DeepSeek classification sends up to 30K chars of each session transcript to api.deepseek.com.");
      log.info("  Anything in a transcript (pasted keys, client names, internal URLs) leaves this machine.");
      log.info("  Pick Ollama (local) above if that's not acceptable.");

      const model = await select<string>({
        message: "Which DeepSeek model?",
        options: [
          { value: "deepseek-v4-flash", label: "deepseek-v4-flash", hint: "recommended — fast + cheap, ~$0.002/session" },
          { value: "deepseek-v4-pro", label: "deepseek-v4-pro", hint: "higher quality, ~10× cost" },
          { value: "deepseek-chat", label: "deepseek-chat", hint: "legacy chat model" },
        ],
      });
      if (isCancel(model)) { cancel("Setup cancelled."); process.exit(0); }

      const key = await password({ message: "DeepSeek API key (get one at platform.deepseek.com):" });
      if (isCancel(key)) { cancel("Setup cancelled."); process.exit(0); }
      const apiKey = key && (key as string).trim() ? (key as string).trim() : undefined;
      writeClassifierConfig(apiKey !== undefined
        ? { choice: "deepseek", model: model as string, apiKey }
        : { choice: "deepseek", model: model as string });
      if (apiKey) {
        log.success(`DeepSeek (${model as string}) configured — credentials saved to ~/.nlm/.env`);
      } else {
        log.warn(`DeepSeek (${model as string}) configured — set DEEPSEEK_API_KEY in ~/.nlm/.env before running.`);
      }
    } else {
      const ollamaModels = await fetchOllamaChatModels();
      let modelValue = "phi4-mini:latest";
      if (ollamaModels.length > 0) {
        const model = await select<string>({
          message: "Which Ollama chat model?",
          options: ollamaModels.map((m) => ({
            value: m,
            label: m,
            hint: m === "phi4-mini:latest" ? "recommended default — small, fast" : undefined,
          })) as { value: string; label: string; hint?: string }[],
        });
        if (isCancel(model)) { cancel("Setup cancelled."); process.exit(0); }
        modelValue = model as string;
      } else {
        log.warn("No Ollama chat models detected. Defaulting to phi4-mini:latest.");
        log.warn("  Pull a model with: ollama pull phi4-mini  (or any chat model you prefer)");
      }
      writeClassifierConfig({ choice: "ollama-offline", model: modelValue });
      log.success(`Ollama classifier (${modelValue}) saved to ~/.nlm/.env`);
    }
  }

  // ── Step 3.5: HTTP API auth token ─────────────────────────────────────
  // Generate a token if one isn't set so /api/* gets Bearer-protected for
  // non-browser callers (curl, port-forwarded clients). The UI still works
  // because browsers send Origin and we exempt loopback origins.
  const token = ensureMcpToken();
  if (token === process.env["NLM_MCP_TOKEN"] && token.length === 64) {
    log.success("HTTP API auth token saved to ~/.nlm/.env (NLM_MCP_TOKEN)");
  }

  // ── Step 4: migrations ────────────────────────────────────────────────
  const ms = spinner();
  ms.start("Running database migrations");
  try {
    const { SqliteStorage } = await import("../core/storage/sqlite-storage.js");
    const storage = SqliteStorage.create({ dbPath: opts.dbPath, migrationsDir: opts.migrationsDir });
    await storage.init();
    await storage.close();
    ms.stop("Database ready");
  } catch (e) {
    ms.stop("Migration failed");
    log.error(`${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // ── Step 4.5: harden ~/.nlm permissions ────────────────────────────────
  // Idempotent. Covers upgrade from pre-v0.4.2 installs where files were
  // written without explicit chmod, leaving secrets world-readable.
  const perms = hardenNlmDirPermissions();
  if (perms.filesHardened + perms.dirsHardened > 0) {
    log.success(`Hardened perms on ${perms.dirsHardened} dirs and ${perms.filesHardened} files in ${perms.nlmDir}`);
  }

  // ── Step 5: daemon ────────────────────────────────────────────────────
  if (OS === "darwin") {
    const installDaemon = await confirm({ message: "Install macOS LaunchAgent (auto-start on login)?" });
    if (isCancel(installDaemon)) { cancel("Setup cancelled."); process.exit(0); }

    if (installDaemon) {
      const ds = spinner();
      ds.start("Installing LaunchAgent");
      try {
        const uid = process.getuid?.();
        if (uid === undefined) throw new Error("Could not determine UID");
        mkdirSync(join(homedir(), ".nlm", "logs"), { recursive: true });
        writeFileSync(opts.launchAgentPlist, opts.buildPlist(opts.nodeExecPath, opts.nlmBinPath), "utf8");
        try {
          execFileSync("launchctl", ["bootout", `gui/${uid}`, opts.launchAgentLabel], { stdio: "ignore" });
        } catch { /* not loaded yet — expected */ }
        execFileSync("launchctl", ["bootstrap", `gui/${uid}`, opts.launchAgentPlist]);
        ds.stop("LaunchAgent installed — daemon running");
      } catch (e) {
        ds.stop("LaunchAgent install failed");
        log.error(`${e instanceof Error ? e.message : String(e)}`);
        log.warn("Run `nlm install` manually later.");
      }
    }
  } else if (OS === "linux") {
    if (opts.linuxSystemdUserAvailable()) {
      const installDaemon = await confirm({ message: "Install systemd user unit (auto-start on login)?" });
      if (isCancel(installDaemon)) { cancel("Setup cancelled."); process.exit(0); }

      if (installDaemon) {
        const ds = spinner();
        ds.start("Installing systemd user unit");
        try {
          mkdirSync(dirname(opts.linuxSystemdUnitPath), { recursive: true });
          mkdirSync(join(homedir(), ".nlm", "logs"), { recursive: true });
          writeFileSync(opts.linuxSystemdUnitPath, opts.buildSystemdUnit(opts.nodeExecPath, opts.nlmBinPath), "utf8");
          execFileSync("systemctl", ["--user", "daemon-reload"]);
          execFileSync("systemctl", ["--user", "enable", "--now", opts.linuxSystemdUnitName]);
          ds.stop("systemd user unit installed — daemon running");
          log.info(`  Status:  systemctl --user status ${opts.linuxSystemdUnitName}`);
          log.info("  Headless? Run `sudo loginctl enable-linger $USER` so the daemon survives logout.");
        } catch (e) {
          ds.stop("systemd install failed");
          log.error(`${e instanceof Error ? e.message : String(e)}`);
          log.warn("Run `nlm install` manually later, or start now with: nlm start &");
        }
      }
    } else {
      log.info("systemd user instance not available (no XDG_RUNTIME_DIR or `systemctl --user`).");
      log.info("  Common on headless servers — start manually with: nlm start &");
      log.info("  Or enable lingering, then re-run `nlm install`:");
      log.info("    sudo loginctl enable-linger $USER");
    }
  } else if (OS === "win32") {
    log.info("Windows daemon: run `nlm start` at login via Task Scheduler.");
    log.info("  Or start manually: nlm start");
  }

  // ── Step 6: per-runtime configuration ────────────────────────────────
  for (const id of chosen) {
    switch (id) {
      case "claude-code": {
        // MCP config
        const cs = spinner();
        cs.start("Configuring Claude Code — MCP server");
        try {
          const report = connectClaudeCode({ nlmBinPath: opts.nlmBinPath, nodeExecPath: opts.nodeExecPath });
          cs.stop(`MCP server ${report.alreadyPresent ? "updated" : "written"} → ${report.mcpConfigPath}`);
        } catch (e) {
          cs.stop("MCP config write failed");
          log.error(`${e instanceof Error ? e.message : String(e)}`);
        }

        // Hooks — Claude Code hooks are process hooks (settings.json), not
        // OS-level scripts, so they work on all platforms where Claude Code runs.
        const hs = spinner();
        hs.start("Configuring Claude Code — session hooks");
        const hookResult = installClaudeCodeHooks({
          nodeExecPath: opts.nodeExecPath,
          hooks: opts.allHooks,
          settingsPath: opts.claudeSettingsPath,
          addHook: opts.addHook,
          removeHook: opts.removeHook,
          buildHookCommand: opts.buildHookCommand,
        });
        if (hookResult.ok) {
          hs.stop(`${hookResult.count} hooks installed → ${opts.claudeSettingsPath}`);
        } else {
          hs.stop(`Hook install failed (${hookResult.failedLabel ?? "unknown"})`);
          if (hookResult.errorMessage) log.error(hookResult.errorMessage);
          log.warn("Run `nlm hook install` manually after checking your Node path.");
        }
        break;
      }

      case "codex": {
        if (!codexBinaryAvailable()) {
          log.warn("Codex binary not found — install with `npm i -g @openai/codex`, then run `nlm connect codex`.");
          break;
        }
        const cs = spinner();
        cs.start("Connecting Codex");
        try {
          const report = connectCodex({ source: "pbmagnet4/nlm-memory-ts" }, pluginScriptsDir(opts.repoRoot));
          if (report.marketplaceAdd?.status !== 0 || report.pluginAdd?.status !== 0) {
            cs.stop("Codex connect had errors — run `nlm connect codex` manually to retry");
          } else {
            cs.stop("Codex marketplace + plugin registered");
          }
        } catch (e) {
          cs.stop("Codex connect failed");
          log.error(`${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }

      case "opencode":
        log.success("OpenCode: session scanning enabled (passive — no extra config needed)");
        break;

      case "hermes": {
        const hs = spinner();
        hs.start("Configuring Hermes");
        try {
          const report = connectHermes({ nlmBinPath: opts.nlmBinPath, nodeExecPath: opts.nodeExecPath });
          hs.stop(`MCP server ${report.alreadyPresent ? "updated" : "written"} → ${report.configPath}`);
        } catch (e) {
          hs.stop("Hermes config write failed");
          log.error(`${e instanceof Error ? e.message : String(e)}`);
          log.warn("Run `nlm connect hermes` manually after checking ~/.hermes/config.yaml.");
        }
        break;
      }

      case "pi": {
        const ps = spinner();
        ps.start("Configuring pi.dev — prompt-recall extension");
        try {
          const pluginDir = join(opts.repoRoot, "nlm");
          const report = connectPi({ pluginDir });
          ps.stop(
            report.alreadyPresent
              ? `pi extension already registered → ${report.pluginDir}`
              : `pi extension registered → ${report.settingsPath} (restart pi to activate)`,
          );
        } catch (e) {
          ps.stop("pi extension wiring failed");
          log.error(`${e instanceof Error ? e.message : String(e)}`);
          log.warn("Run `nlm connect pi` manually after fixing ~/.pi/agent/settings.json.");
        }
        break;
      }

      default: {
        const _: never = id;
        log.warn(`Unknown runtime: ${_ as string} — skipping.`);
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const needsRestart: string[] = [];
  if (chosen.includes("claude-code")) needsRestart.push("Claude Code");
  if (chosen.includes("hermes")) needsRestart.push("Hermes");

  outro(
    needsRestart.length > 0
      ? `Done! Restart ${needsRestart.join(" and ")} for the MCP server to activate, then start a session — memory will follow.`
      : "Done! Start a session in any configured runtime and NLM will begin indexing automatically.",
  );
}
