/**
 * `nlm connect claude-code` / `nlm disconnect claude-code` — writes the
 * nlm-memory MCP server block into ~/.mcp.json and removes it on disconnect.
 *
 * ~/.mcp.json is the global MCP config file that Claude Code reads on
 * startup. We merge our entry into the existing mcpServers object rather
 * than replacing the file, so other MCP servers the user has configured are
 * preserved.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ClaudeHookEvent } from "../core/hook/claude-settings.js";

export interface ConnectClaudeCodeOptions {
  readonly nlmBinPath: string;
  readonly nodeExecPath: string;
  readonly dryRun?: boolean;
}

export interface ConnectClaudeCodeReport {
  readonly mcpConfigPath: string;
  readonly alreadyPresent: boolean;
  readonly written: boolean;
  readonly dryRun: boolean;
}

export interface DisconnectClaudeCodeReport {
  readonly mcpConfigPath: string;
  readonly removed: boolean;
  readonly dryRun: boolean;
}

export function mcpConfigPath(): string {
  return process.env["NLM_MCP_CONFIG"] ?? join(homedir(), ".mcp.json");
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} is not valid JSON. Fix or remove it, then re-run \`nlm connect claude-code\`.`);
  }
}

export function connectClaudeCode(opts: ConnectClaudeCodeOptions): ConnectClaudeCodeReport {
  const configPath = mcpConfigPath();
  const config = readConfig(configPath);
  const mcpServers = (config["mcpServers"] ?? {}) as Record<string, unknown>;
  const alreadyPresent = "nlm-memory" in mcpServers;

  if (!opts.dryRun) {
    mcpServers["nlm-memory"] = {
      command: opts.nodeExecPath,
      args: [opts.nlmBinPath, "mcp"],
    };
    config["mcpServers"] = mcpServers;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }

  return { mcpConfigPath: configPath, alreadyPresent, written: !opts.dryRun, dryRun: opts.dryRun ?? false };
}

// ── Hook install helper (shared by setup wizard + connect --with-hooks) ──────

export interface HookSpec {
  readonly event: ClaudeHookEvent;
  readonly script: string;
  readonly label: string;
}

export interface HookInstallOptions {
  readonly nodeExecPath: string;
  readonly hooks: ReadonlyArray<HookSpec>;
  readonly settingsPath: string;
  readonly hookLogPath: string;
  readonly addHook: (path: string, command: string, event?: ClaudeHookEvent) => void;
  readonly removeHook: (path: string, event?: ClaudeHookEvent | "*") => void;
  readonly buildHookCommand: (nodeExec: string, script: string, mode: "shadow" | "live") => string;
  readonly smokeTestHookCommand: (command: string, logPath: string) => { ok: boolean; reason?: string; stderr?: string };
}

export interface HookInstallResult {
  readonly ok: boolean;
  readonly count: number;
  readonly failedLabel?: string;
  readonly errorMessage?: string;
}

export function installClaudeCodeHooks(opts: HookInstallOptions): HookInstallResult {
  const installed: HookSpec[] = [];
  for (const spec of opts.hooks) {
    try {
      const command = opts.buildHookCommand(opts.nodeExecPath, spec.script, "live");
      opts.addHook(opts.settingsPath, command, spec.event);
      const smoke = opts.smokeTestHookCommand(command, opts.hookLogPath);
      if (!smoke.ok) {
        for (const prior of [...installed, spec]) opts.removeHook(opts.settingsPath, prior.event);
        const result: HookInstallResult = { ok: false, count: installed.length, failedLabel: spec.label };
        return smoke.reason ? { ...result, errorMessage: smoke.reason } : result;
      }
      installed.push(spec);
    } catch (e) {
      return { ok: false, count: installed.length, failedLabel: spec.label, errorMessage: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: true, count: installed.length };
}

export function disconnectClaudeCode(opts?: { dryRun?: boolean }): DisconnectClaudeCodeReport {
  const configPath = mcpConfigPath();
  const config = readConfig(configPath);
  const mcpServers = config["mcpServers"] as Record<string, unknown> | undefined;

  if (!mcpServers || !("nlm-memory" in mcpServers)) {
    return { mcpConfigPath: configPath, removed: false, dryRun: opts?.dryRun ?? false };
  }

  if (!opts?.dryRun) {
    delete mcpServers["nlm-memory"];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }

  return { mcpConfigPath: configPath, removed: true, dryRun: opts?.dryRun ?? false };
}
