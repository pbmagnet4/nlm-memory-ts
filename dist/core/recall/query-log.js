/**
 * Query log + stats aggregation. Mirrors recall.py's log_query() / stats().
 *
 * Telemetry path — never raises. The HTTP recall handler calls logQuery()
 * after each /api/recall response; /api/recall/stats reads the same file
 * back to drive the Pulse agent-recall observability panel.
 *
 * File format: one JSON object per line at $NLM_QUERY_LOG or
 * ~/.nlm/query_log.jsonl. Append-only.
 */
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
function defaultLogPath() {
    return process.env["NLM_QUERY_LOG"] ?? join(homedir(), ".nlm", "query_log.jsonl");
}
export async function logQuery(entry, logPath = defaultLogPath()) {
    try {
        await mkdir(dirname(logPath), { recursive: true });
        const payload = {
            ts: new Date().toISOString(),
            source: entry.source,
            query: entry.query,
            entity: entry.entity,
            kind: entry.kind,
            mode: entry.mode,
            limit: entry.limit,
            n_results: entry.nResults,
            returned_ids: entry.returnedIds,
        };
        await appendFile(logPath, JSON.stringify(payload) + "\n", "utf8");
    }
    catch {
        // Telemetry must never break the call path.
    }
}
export async function recallStats(days, logPath = defaultLogPath()) {
    const base = {
        days,
        total: 0,
        with_results: 0,
        hit_rate: 0,
        by_source: {},
        top_queries: [],
        log_present: false,
    };
    try {
        await stat(logPath);
    }
    catch {
        return base;
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const bySource = new Map();
    const queryCounts = new Map();
    let total = 0;
    let withResults = 0;
    let raw;
    try {
        raw = await readFile(logPath, "utf8");
    }
    catch {
        return { ...base, log_present: true };
    }
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
        total += 1;
        const n = typeof entry["n_results"] === "number" ? entry["n_results"] : 0;
        if (n > 0)
            withResults += 1;
        const source = typeof entry["source"] === "string" ? entry["source"] : "unknown";
        bySource.set(source, (bySource.get(source) ?? 0) + 1);
        const q = entry["query"];
        if (typeof q === "string" && q) {
            const norm = q.toLowerCase().trim();
            queryCounts.set(norm, (queryCounts.get(norm) ?? 0) + 1);
        }
    }
    const sortedSources = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
    const sortedQueries = [...queryCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    return {
        days,
        total,
        with_results: withResults,
        hit_rate: total === 0 ? 0 : Math.round((withResults / total) * 1000) / 1000,
        by_source: Object.fromEntries(sortedSources),
        top_queries: sortedQueries.map(([query, count]) => ({ query, count })),
        log_present: true,
    };
}
//# sourceMappingURL=query-log.js.map