/**
 * Append-only JSONL audit log for post-hoc supersedence mutations. One line
 * per `mark_superseded` MCP call (or future UI action). Atomic-on-insert
 * supersedence at ingest time is not logged here — that lineage is already
 * implicit in the session_edges row's predecessor reference.
 *
 * Path defaults to ~/.nlm/supersedence-log.jsonl, overridable via
 * NLM_SUPERSEDENCE_LOG. Telemetry path — never raises.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
function defaultLogPath() {
    return (process.env["NLM_SUPERSEDENCE_LOG"] ??
        join(homedir(), ".nlm", "supersedence-log.jsonl"));
}
export async function appendSupersedence(entry, logPath = defaultLogPath()) {
    try {
        await mkdir(dirname(logPath), { recursive: true });
        const payload = {
            ts: new Date().toISOString(),
            predecessor_id: entry.predecessorId,
            successor_id: entry.successorId,
            ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
            ...(entry.source !== undefined ? { source: entry.source } : {}),
        };
        await appendFile(logPath, JSON.stringify(payload) + "\n", "utf8");
    }
    catch {
        // Telemetry failure must never break the call path.
    }
}
//# sourceMappingURL=supersedence-log.js.map