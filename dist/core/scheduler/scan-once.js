/**
 * scanOnce — mtime-gated incremental discovery shared by every adapter.
 *
 * The Python codebase bundled this logic into each adapter (`scan_once` +
 * `record_classified` methods). In the TS port the adapter stays a pure
 * parser (TranscriptAdapter port); the mtime check and adapter_state
 * upsert live here, generic over the adapter. Same behavior, less
 * duplication across claude-code / hermes / pi.
 *
 * Contract (per file under adapter.discover()):
 *   - If `now - mtime < idleMinutes * 60s` → still active, skip
 *   - Lookup adapter_state by (adapterName, sourcePath):
 *       no row + file idle      → NEW: parse + return (chunk, supersedes=null)
 *       row exists, size match  → UNCHANGED: skip
 *       row exists, file grew   → RESUMED: parse + return (chunk, prior.session_id)
 *   - After successful classify+insert downstream, call `recordClassified`
 *     to upsert adapter_state with the new size + session_id.
 */
import { statSync } from "node:fs";
export async function scanOnce(adapter, idleMinutes, db, now = Date.now()) {
    const idleMs = idleMinutes * 60 * 1000;
    const stateRows = db
        .prepare("SELECT source_path, file_size, session_id FROM adapter_state WHERE adapter_name = ?")
        .all(adapter.name);
    const byPath = new Map(stateRows.map((r) => [r.source_path, r]));
    const out = [];
    const files = await adapter.discover();
    for (const path of files) {
        let st;
        try {
            st = statSync(path);
        }
        catch {
            continue;
        }
        const age = now - st.mtimeMs;
        if (age < idleMs)
            continue;
        const prior = byPath.get(path);
        let supersedes = null;
        if (prior) {
            if ((prior.file_size ?? 0) === st.size) {
                continue; // unchanged since last classification
            }
            supersedes = prior.session_id;
        }
        const chunk = await adapter.parseSession(path);
        if (!chunk)
            continue;
        out.push({ chunk, supersedes });
    }
    return out;
}
export function recordClassified(db, adapterName, sourcePath, sessionId) {
    let size = 0;
    try {
        size = statSync(sourcePath).size;
    }
    catch {
        return;
    }
    db.prepare(`INSERT INTO adapter_state
       (adapter_name, source_path, last_offset, file_size, session_id, last_processed_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(adapter_name, source_path) DO UPDATE SET
       last_offset = excluded.last_offset,
       file_size = excluded.file_size,
       session_id = excluded.session_id,
       last_processed_at = excluded.last_processed_at`).run(adapterName, sourcePath, size, size, sessionId);
}
//# sourceMappingURL=scan-once.js.map