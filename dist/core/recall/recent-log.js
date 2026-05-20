/**
 * recentLog — tail the query log for the /live observability panel.
 * Returns the last N entries in chronological order (most recent first).
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function defaultLogPath() {
    return process.env["NLM_QUERY_LOG"] ?? join(homedir(), ".nlm", "query_log.jsonl");
}
const TAIL_BYTES = 256 * 1024;
export function recentQueryLog(limit, logPath = defaultLogPath()) {
    if (!existsSync(logPath))
        return [];
    const size = statSync(logPath).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const tail = readFileSync(logPath, { encoding: "utf8" }).slice(start);
    const entries = [];
    for (const line of tail.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const raw = JSON.parse(trimmed);
            entries.push({
                ts: typeof raw["ts"] === "string" ? raw["ts"] : "",
                source: typeof raw["source"] === "string" ? raw["source"] : "unknown",
                query: typeof raw["query"] === "string" ? raw["query"] : null,
                entity: typeof raw["entity"] === "string" ? raw["entity"] : null,
                kind: typeof raw["kind"] === "string" ? raw["kind"] : null,
                mode: typeof raw["mode"] === "string" ? raw["mode"] : "keyword",
                limit: typeof raw["limit"] === "number" ? raw["limit"] : 0,
                nResults: typeof raw["n_results"] === "number" ? raw["n_results"] : 0,
                returnedIds: Array.isArray(raw["returned_ids"])
                    ? raw["returned_ids"].filter((x) => typeof x === "string")
                    : [],
            });
        }
        catch {
            continue;
        }
    }
    entries.sort((a, b) => b.ts.localeCompare(a.ts));
    return entries.slice(0, limit);
}
//# sourceMappingURL=recent-log.js.map