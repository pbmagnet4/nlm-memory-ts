/**
 * `nlm connect pi` / `nlm disconnect pi` — registers the bundled pi extension
 * in pi.dev's settings so the prompt-recall hook auto-loads on every pi start.
 *
 * Pi has no plugin install directory analogous to Hermes' ~/.hermes/plugins/.
 * Instead, pi reads `packages: [...]` from ~/.pi/agent/settings.json and
 * resolves each entry on startup — a path to a directory containing an
 * `index.js` (or `index.ts`) auto-loads as the extension entry.
 *
 * The nlm/ directory inside this npm package ships exactly that shape:
 * `index.js` is the bundled extension; `package.json` declares `type: module`.
 * Pi's interactive UI strips `index.{ts,js}` from the display path, so the
 * extension surfaces as `nlm` in the [Extensions] list — matching the
 * naming convention used by pi-mcp-adapter, whtnxt-tasks, etc.
 *
 * `connect` appends the absolute path to that directory into `packages` if
 * not already present. `disconnect` strips any matching entry.
 *
 * Idempotent. Format-preserving where possible — pi's settings.json is pure
 * JSON with no comments, so JSON.parse / JSON.stringify with 2-space indent
 * matches pi's own write convention.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
export function piAgentDir() {
    return process.env["NLM_PI_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
}
export function piSettingsPath() {
    return join(piAgentDir(), "settings.json");
}
function readSettings(path) {
    if (!existsSync(path))
        return {};
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        // Malformed settings — fail loud rather than overwrite. Pi itself would
        // also reject this; we don't want to mask the underlying problem.
        throw new Error(`pi settings.json at ${path} is not valid JSON`);
    }
}
function writeSettings(path, settings) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
export function connectPi(opts) {
    const settingsPath = piSettingsPath();
    const pluginDir = resolve(opts.pluginDir);
    const settings = readSettings(settingsPath);
    const rawPackages = Array.isArray(settings.packages) ? settings.packages : [];
    // Drop any legacy `plugin-pi` entries from nlm-memory <= 0.5.19 so the
    // user doesn't end up with both the old basename and the new `nlm` one.
    // The old path no longer resolves on disk after upgrade, so pi would
    // silently fail to load it — cleaner to strip it here.
    const packages = rawPackages.filter((p) => basename(resolve(p)) !== "plugin-pi");
    const migrated = packages.length !== rawPackages.length;
    const alreadyPresent = packages.some((p) => resolve(p) === pluginDir);
    if (alreadyPresent && !migrated) {
        return {
            settingsPath,
            pluginDir,
            alreadyPresent: true,
            written: false,
            dryRun: Boolean(opts.dryRun),
        };
    }
    if (opts.dryRun) {
        return {
            settingsPath,
            pluginDir,
            alreadyPresent,
            written: false,
            dryRun: true,
        };
    }
    if (!alreadyPresent)
        packages.push(pluginDir);
    writeSettings(settingsPath, { ...settings, packages });
    return { settingsPath, pluginDir, alreadyPresent, written: true, dryRun: false };
}
export function disconnectPi(opts) {
    const settingsPath = piSettingsPath();
    if (!existsSync(settingsPath)) {
        return { settingsPath, removed: false, dryRun: opts?.dryRun ?? false };
    }
    const settings = readSettings(settingsPath);
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    // Match on basename so we strip any nlm entry regardless of where the
    // user's npm prefix put the nlm-memory install. Also strips the legacy
    // basename "plugin-pi" left behind by nlm-memory <= 0.5.19 so users who
    // ran the older connect still get a clean disconnect.
    const filtered = packages.filter((p) => {
        const base = basename(resolve(p));
        return base !== "nlm" && base !== "plugin-pi";
    });
    if (filtered.length === packages.length) {
        return { settingsPath, removed: false, dryRun: opts?.dryRun ?? false };
    }
    if (opts?.dryRun) {
        return { settingsPath, removed: false, dryRun: true };
    }
    writeSettings(settingsPath, { ...settings, packages: filtered });
    return { settingsPath, removed: true, dryRun: false };
}
//# sourceMappingURL=pi.js.map