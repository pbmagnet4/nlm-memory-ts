/**
 * Detects which surfaced recall IDs an assistant turn cited.
 *
 * Two channels, ordered by signal strength:
 *  - tool_use:  the model invoked an MCP NLM tool (get_session, recall_facts,
 *               get_fact_history, recall_sessions) whose input references a
 *               surfaced ID. This is the strong "the model dug into the
 *               surfaced session" signal. Almost no false positives.
 *  - prose:     the surfaced ID appears as a substring in the response text.
 *               Models rarely echo session IDs verbatim, so this channel
 *               fires in practice almost never — kept for completeness.
 *
 * Returns both the union of cited IDs and the per-ID channel so the citation
 * log can carry kind metadata. ID minimum length keeps generic short tokens
 * from false-positiving against either channel.
 *
 * This is the training-data substrate for a future learned reranker.
 */
const MIN_ID_LEN = 6;
export function detectCitations(input) {
    const surfaced = [];
    const seen = new Set();
    for (const id of input.surfacedIds) {
        if (id.length < MIN_ID_LEN)
            continue;
        if (seen.has(id))
            continue;
        seen.add(id);
        surfaced.push(id);
    }
    const cited = [];
    const claimedByToolUse = new Set();
    // Channel A: tool_use. Two sub-cases:
    //
    // A1: cite_session — the model called the explicit citation primitive with
    //     the session ID in tu.input.id. Strongest possible signal: structured,
    //     deterministic, zero ambiguity. ID must be a surfaced session ID.
    //
    // A2: other NLM tools (get_session, recall_sessions, recall_facts,
    //     get_fact_history) — stringify the input and substring-scan for surfaced
    //     IDs. These tools accept ids via top-level fields, so the serialization
    //     always includes the id when used.
    for (const tu of input.toolUses) {
        if (!isNlmTool(tu.name))
            continue;
        if (isCiteSessionTool(tu.name)) {
            // A1: explicit cite_session call — id is in tu.input.id directly.
            const explicitId = safeInputId(tu.input);
            if (explicitId && surfaced.includes(explicitId) && !claimedByToolUse.has(explicitId)) {
                cited.push({ id: explicitId, kind: "tool_use" });
                claimedByToolUse.add(explicitId);
            }
            continue;
        }
        // A2: other NLM tools — serialize and substring-scan.
        const serialized = safeStringify(tu.input);
        if (!serialized)
            continue;
        for (const id of surfaced) {
            if (claimedByToolUse.has(id))
                continue;
            if (serialized.includes(id)) {
                cited.push({ id, kind: "tool_use" });
                claimedByToolUse.add(id);
            }
        }
    }
    // Channel B: prose. Only emit if the tool_use channel didn't already
    // claim this id — same id shouldn't double-count.
    if (input.responseText) {
        for (const id of surfaced) {
            if (claimedByToolUse.has(id))
                continue;
            if (input.responseText.includes(id)) {
                cited.push({ id, kind: "prose" });
            }
        }
    }
    return cited;
}
/** Back-compat: prose-only detector returning a flat id list. */
export function detectCitedIds(responseText, surfacedIds) {
    return detectCitations({
        responseText,
        toolUses: [],
        surfacedIds,
    }).map((c) => c.id);
}
function isNlmTool(name) {
    // Claude Code namespaces MCP tools as `mcp__<server>__<tool>`. The NLM
    // server name is "nlm-memory" in the user's .mcp.json today; accept any
    // server name containing "nlm" so future renames stay covered.
    return /^mcp__[^_]*nlm[^_]*__/.test(name);
}
function isCiteSessionTool(name) {
    return name.endsWith("__cite_session");
}
function safeInputId(input) {
    if (typeof input === "object" && input !== null && "id" in input) {
        const id = input["id"];
        if (typeof id === "string")
            return id;
    }
    return undefined;
}
function safeStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return "";
    }
}
//# sourceMappingURL=citation-detect.js.map