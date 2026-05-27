/**
 * `nlm connect codex` / `nlm disconnect codex` — installs nlm-memory as a
 * Codex CLI plugin via the marketplace mechanism.
 *
 * Two distribution surfaces:
 *
 * 1. The plugin path (default). Registers a Codex marketplace pointing at
 *    pbmagnet4/nlm-memory-ts and installs the `nlm-memory` plugin from it.
 *    Codex prompts for hook trust on first invocation; once trusted,
 *    UserPromptSubmit + Stop hooks fire, and the .mcp.json wires the
 *    `nlm-memory` MCP server alongside.
 *
 * 2. The legacy hooks.json fallback (--with-hooks). For Codex Desktop
 *    builds where openai/codex#16430 blocks plugin-local hook dispatch,
 *    additionally writes absolute paths into ~/.codex/hooks.json so the
 *    hooks fire via the project-local code path. MCP still comes through
 *    the plugin's .mcp.json.
 *
 * Marketplace + plugin add are delegated to the `codex` binary rather than
 * mutating ~/.codex/config.toml directly — the binary owns the trust state
 * machine and the snapshot fetch flow, and writing TOML by hand would race
 * against codex's own writes. The legacy hooks.json IS authored directly
 * because it's a project-local file the binary doesn't manage.
 */
export interface ConnectOptions {
    readonly source?: string;
    readonly withHooks?: boolean;
    readonly dryRun?: boolean;
}
export interface DisconnectOptions {
    readonly withHooks?: boolean;
    readonly dryRun?: boolean;
}
export interface CodexCommandResult {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}
export declare function codexBinaryAvailable(): boolean;
export declare function codexHooksPath(): string;
export declare function codexConfigPath(): string;
/**
 * Idempotently insert (or update) the [mcp_servers.nlm-memory] block in
 * ~/.codex/config.toml. The block is bracketed by sentinel comments so a
 * later disconnect can strip the exact region without touching anything
 * else. MCP wiring is universal infrastructure — every runtime gets its
 * MCP server registered in its native format. Codex's is TOML in
 * config.toml; we write that directly rather than relying on the plugin
 * system's .mcp.json indirection (which we can't currently verify works
 * outside the upstream plugin pipeline).
 */
export declare function writeMcpServerToConfig(configPath: string): void;
export declare function removeMcpServerFromConfig(configPath: string): boolean;
/**
 * Append our two hook entries into ~/.codex/hooks.json without touching any
 * pre-existing entries. Idempotent: a second call replaces our entries
 * rather than duplicating them (matched by LEGACY_HOOK_MARKER substring).
 */
export declare function writeLegacyHooks(pluginScriptsDir: string, hooksPath: string): void;
export declare function removeLegacyHooks(hooksPath: string): boolean;
export interface ConnectReport {
    readonly source: string;
    readonly marketplaceName: string;
    readonly pluginName: string;
    readonly marketplaceAdd: CodexCommandResult | null;
    readonly pluginAdd: CodexCommandResult | null;
    readonly legacyHooksWritten: string | null;
    readonly mcpServerWritten: string | null;
    readonly dryRun: boolean;
}
export declare function connectCodex(opts: ConnectOptions, pluginScriptsDir: string): ConnectReport;
export interface DisconnectReport {
    readonly marketplaceName: string;
    readonly pluginName: string;
    readonly pluginRemove: CodexCommandResult | null;
    readonly marketplaceRemove: CodexCommandResult | null;
    readonly legacyHooksRemoved: boolean;
    readonly mcpServerRemoved: boolean;
    readonly dryRun: boolean;
}
export declare function disconnectCodex(opts: DisconnectOptions): DisconnectReport;
export declare function pluginScriptsDir(repoRoot: string): string;
