/**
 * Idempotent key=value edits to a `.env` file. Used by `nlm config` to
 * toggle settings (NLM_UI_AUTH, etc.) without dragging in a YAML/JSON
 * settings layer. The format is the same one autoloadEnv reads.
 *
 * Behavior:
 *   - If the key exists, the value is replaced in place (preserves order,
 *     surrounding comments, and other lines untouched)
 *   - If the key doesn't exist, the assignment is appended at end of file
 *   - Setting an explicit empty value (`KEY=`) is supported; passing
 *     `null` removes the line entirely
 *
 * Pure function — caller handles file IO. Splitting this out keeps the
 * fiddly format-preservation logic unit-testable.
 */
export declare function applyEnvAssignment(contents: string, key: string, value: string | null): string;
