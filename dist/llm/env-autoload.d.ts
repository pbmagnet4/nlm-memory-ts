/**
 * Mirror of `classifier.autoload_env` from the Python daemon. Reads KEY=VALUE
 * pairs from a small list of likely .env locations into process.env. Existing
 * env vars are NOT overridden.
 *
 * Returns the list of paths actually loaded. Safe to call multiple times.
 */
export declare function autoloadEnv(extraPaths?: ReadonlyArray<string>): string[];
