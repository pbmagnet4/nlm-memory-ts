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
import type { ClaudeHookEvent } from "../core/hook/claude-settings.js";
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
    readonly smokeTestHookCommand: (command: string, logPath: string) => {
        ok: boolean;
        reason?: string;
        stderr?: string;
    };
}
export declare function runSetup(opts: SetupOptions): Promise<void>;
