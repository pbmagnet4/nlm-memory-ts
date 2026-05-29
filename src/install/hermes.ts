/**
 * `nlm connect hermes` / `nlm disconnect hermes` — writes the nlm-memory
 * MCP server entry into ~/.hermes/config.yaml.
 *
 * Uses yaml's Document API (parseDocument / doc.setIn / doc.toString) to
 * preserve any comments the user has written in their config file. Round-
 * tripping through parse+stringify would silently destroy comments.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Document as YamlDocument, parseDocument as parseYamlDocument } from "yaml";

export interface ConnectHermesOptions {
  readonly nlmBinPath: string;
  readonly nodeExecPath: string;
  readonly dryRun?: boolean;
}

export interface ConnectHermesReport {
  readonly configPath: string;
  readonly alreadyPresent: boolean;
  readonly written: boolean;
  readonly dryRun: boolean;
}

export interface DisconnectHermesReport {
  readonly configPath: string;
  readonly removed: boolean;
  readonly dryRun: boolean;
}

export function hermesConfigPath(): string {
  return process.env["NLM_HERMES_CONFIG"] ?? join(homedir(), ".hermes", "config.yaml");
}

function readDocument(path: string): YamlDocument {
  if (!existsSync(path)) return new YamlDocument();
  try {
    return parseYamlDocument(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid YAML. Fix or remove it, then re-run \`nlm connect hermes\`.`);
  }
}

export function connectHermes(opts: ConnectHermesOptions): ConnectHermesReport {
  const configPath = hermesConfigPath();
  const doc = readDocument(configPath);
  const alreadyPresent = doc.getIn(["mcp_servers", "nlm-memory"]) !== undefined;

  if (!opts.dryRun) {
    doc.setIn(["mcp_servers", "nlm-memory"], {
      command: opts.nodeExecPath,
      args: [opts.nlmBinPath, "mcp"],
    });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, doc.toString(), "utf8");
  }

  return { configPath, alreadyPresent, written: !opts.dryRun, dryRun: opts.dryRun ?? false };
}

export function disconnectHermes(opts?: { dryRun?: boolean }): DisconnectHermesReport {
  const configPath = hermesConfigPath();
  const doc = readDocument(configPath);

  if (doc.getIn(["mcp_servers", "nlm-memory"]) === undefined) {
    return { configPath, removed: false, dryRun: opts?.dryRun ?? false };
  }

  if (!opts?.dryRun) {
    doc.deleteIn(["mcp_servers", "nlm-memory"]);
    writeFileSync(configPath, doc.toString(), "utf8");
  }

  return { configPath, removed: true, dryRun: opts?.dryRun ?? false };
}
