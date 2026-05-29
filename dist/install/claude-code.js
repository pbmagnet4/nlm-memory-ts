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
export function mcpConfigPath() {
    return process.env["NLM_MCP_CONFIG"] ?? join(homedir(), ".mcp.json");
}
function readConfig(path) {
    if (!existsSync(path))
        return {};
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        throw new Error(`${path} is not valid JSON. Fix or remove it, then re-run \`nlm connect claude-code\`.`);
    }
}
export function connectClaudeCode(opts) {
    const configPath = mcpConfigPath();
    const config = readConfig(configPath);
    const mcpServers = (config["mcpServers"] ?? {});
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
export function installClaudeCodeHooks(opts) {
    const installed = [];
    for (const spec of opts.hooks) {
        try {
            const command = opts.buildHookCommand(opts.nodeExecPath, spec.script, "live");
            opts.addHook(opts.settingsPath, command, spec.event);
            const smoke = opts.smokeTestHookCommand(command, opts.hookLogPath);
            if (!smoke.ok) {
                for (const prior of [...installed, spec])
                    opts.removeHook(opts.settingsPath, prior.event);
                const result = { ok: false, count: installed.length, failedLabel: spec.label };
                return smoke.reason ? { ...result, errorMessage: smoke.reason } : result;
            }
            installed.push(spec);
        }
        catch (e) {
            return { ok: false, count: installed.length, failedLabel: spec.label, errorMessage: e instanceof Error ? e.message : String(e) };
        }
    }
    return { ok: true, count: installed.length };
}
export function disconnectClaudeCode(opts) {
    const configPath = mcpConfigPath();
    const config = readConfig(configPath);
    const mcpServers = config["mcpServers"];
    if (!mcpServers || !("nlm-memory" in mcpServers)) {
        return { mcpConfigPath: configPath, removed: false, dryRun: opts?.dryRun ?? false };
    }
    if (!opts?.dryRun) {
        delete mcpServers["nlm-memory"];
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    }
    return { mcpConfigPath: configPath, removed: true, dryRun: opts?.dryRun ?? false };
}
//# sourceMappingURL=claude-code.js.map