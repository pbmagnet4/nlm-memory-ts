/**
 * Mirror of `classifier.autoload_env` from the Python daemon. Reads KEY=VALUE
 * pairs from a small list of likely .env locations into process.env. Existing
 * env vars are NOT overridden.
 *
 * Returns the list of paths actually loaded. Safe to call multiple times.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
const DEFAULT_SEARCH_PATHS = [
    "~/.nlm/.env",
    "./.env",
    "../.env",
    "../../.env",
];
function expandHome(p) {
    if (p.startsWith("~/"))
        return resolve(homedir(), p.slice(2));
    return p;
}
export function autoloadEnv(extraPaths = []) {
    const loaded = [];
    const paths = [...DEFAULT_SEARCH_PATHS, ...extraPaths];
    for (const raw of paths) {
        const path = expandHome(raw);
        if (!existsSync(path))
            continue;
        try {
            const content = readFileSync(path, "utf8");
            for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("="))
                    continue;
                const eq = trimmed.indexOf("=");
                const key = trimmed.slice(0, eq).trim();
                let value = trimmed.slice(eq + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                if (key && process.env[key] === undefined) {
                    process.env[key] = value;
                }
            }
            loaded.push(path);
        }
        catch {
            continue;
        }
    }
    return loaded;
}
//# sourceMappingURL=env-autoload.js.map