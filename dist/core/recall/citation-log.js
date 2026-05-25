/**
 * Append-only JSONL citation log. One line per (conversationId, citedId)
 * that the Stop hook detected. This is the training-data substrate for the
 * future learned reranker: each row is a (query, returned_id, was_cited)
 * triple once joined against ~/.nlm/query_log.jsonl by conversationId.
 *
 * Path defaults to ~/.nlm/citation-log.jsonl, overridable via
 * NLM_CITATION_LOG. Telemetry path — never raises.
 */
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
function defaultLogPath() {
    return process.env["NLM_CITATION_LOG"] ?? join(homedir(), ".nlm", "citation-log.jsonl");
}
export async function appendCitation(entry, logPath = defaultLogPath()) {
    try {
        await mkdir(dirname(logPath), { recursive: true });
        const payload = {
            ts: new Date().toISOString(),
            conversation_id: entry.conversationId,
            cited_id: entry.citedId,
            ...(entry.responsePreview !== undefined
                ? { response_preview: entry.responsePreview }
                : {}),
        };
        await appendFile(logPath, JSON.stringify(payload) + "\n", "utf8");
    }
    catch {
        // Telemetry failure must never break the call path.
    }
}
export async function citationStats(days, logPath = defaultLogPath()) {
    const base = {
        days,
        total: 0,
        distinct_ids: 0,
        top_ids: [],
        log_present: false,
    };
    try {
        await stat(logPath);
    }
    catch {
        return base;
    }
    let raw;
    try {
        raw = await readFile(logPath, "utf8");
    }
    catch {
        return { ...base, log_present: true };
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const counts = new Map();
    let total = 0;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let entry;
        try {
            entry = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        const tsRaw = entry["ts"];
        if (typeof tsRaw !== "string")
            continue;
        const ts = Date.parse(tsRaw);
        if (!Number.isFinite(ts) || ts < cutoff)
            continue;
        const id = entry["cited_id"];
        if (typeof id !== "string" || !id)
            continue;
        total += 1;
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    return {
        days,
        total,
        distinct_ids: counts.size,
        top_ids: sorted.map(([id, count]) => ({ id, count })),
        log_present: true,
    };
}
//# sourceMappingURL=citation-log.js.map