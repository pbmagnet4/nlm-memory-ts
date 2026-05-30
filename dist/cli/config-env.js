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
export function applyEnvAssignment(contents, key, value) {
    const lines = contents.split("\n");
    let found = false;
    const out = [];
    // Match `KEY=...` with optional leading whitespace and optional `export `.
    // We DON'T match commented-out lines (starting with `#`) — those are
    // intentionally inert.
    const re = new RegExp(`^(\\s*)(export\\s+)?${escapeRegex(key)}=`);
    for (const line of lines) {
        if (re.test(line)) {
            if (value === null) {
                // Remove the line entirely.
                found = true;
                continue;
            }
            const m = re.exec(line);
            if (m) {
                const prefix = m[0];
                out.push(`${prefix}${formatValue(value)}`);
                found = true;
                continue;
            }
        }
        out.push(line);
    }
    if (!found && value !== null) {
        // Drop a single trailing newline before appending so we don't grow
        // empty trailing lines on each call.
        while (out.length > 0 && out[out.length - 1] === "")
            out.pop();
        out.push(`${key}=${formatValue(value)}`);
        out.push("");
    }
    return out.join("\n");
}
function formatValue(value) {
    // Quote if the value has whitespace or starts/ends with a quote-like
    // char that would confuse the loader.
    if (/[\s#"']/.test(value)) {
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//# sourceMappingURL=config-env.js.map