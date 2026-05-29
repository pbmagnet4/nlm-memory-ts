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
 *       no row + file idle                       → NEW: parse + return (chunk, supersedes=null)
 *       row exists, size match, failures < ceil  → UNCHANGED: skip
 *       row exists, size match, failures >= ceil → FAILED_CEILING: skip (log once per session)
 *       row exists, file grew                    → RESUMED: parse + return, reset failure_count
 *   - After successful classify+insert downstream, call `recordClassified`
 *     to upsert adapter_state with the new size + session_id.
 *   - On classify/storage failure, call `recordFailed` to increment failure_count.
 *     When failure_count reaches MAX_CLASSIFY_FAILURES and the file hasn't grown,
 *     the file is permanently skipped until new content arrives.
 */
import { statSync } from "node:fs";
export const MAX_CLASSIFY_FAILURES = 3;
export async function scanOnce(adapter, idleMinutes, db, now = Date.now()) {
    const idleMs = idleMinutes * 60 * 1000;
    const stateRows = db
        .prepare("SELECT source_path, file_size, session_id, COALESCE(failure_count, 0) AS failure_count FROM adapter_state WHERE adapter_name = ?")
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
            const sizeUnchanged = (prior.file_size ?? 0) === st.size;
            if (sizeUnchanged) {
                // File hasn't grown — skip whether clean or failed. Failures only
                // retry when the transcript file receives new content.
                continue;
            }
            // File grew: reset failure_count so resume gets a clean slate.
            if (prior.failure_count >= MAX_CLASSIFY_FAILURES) {
                db.prepare("UPDATE adapter_state SET failure_count = 0 WHERE adapter_name = ? AND source_path = ?").run(adapter.name, path);
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
       (adapter_name, source_path, last_offset, file_size, session_id, failure_count, last_processed_at)
     VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
     ON CONFLICT(adapter_name, source_path) DO UPDATE SET
       last_offset = excluded.last_offset,
       file_size = excluded.file_size,
       session_id = excluded.session_id,
       failure_count = 0,
       last_processed_at = excluded.last_processed_at`).run(adapterName, sourcePath, size, size, sessionId);
}
export function recordFailed(db, adapterName, sourcePath) {
    let size = 0;
    try {
        size = statSync(sourcePath).size;
    }
    catch {
        return;
    }
    db.prepare(`INSERT INTO adapter_state
       (adapter_name, source_path, last_offset, file_size, session_id, failure_count, last_processed_at)
     VALUES (?, ?, ?, ?, NULL, 1, datetime('now'))
     ON CONFLICT(adapter_name, source_path) DO UPDATE SET
       file_size = excluded.file_size,
       failure_count = failure_count + 1,
       last_processed_at = excluded.last_processed_at`).run(adapterName, sourcePath, size, size);
}
//# sourceMappingURL=scan-once.js.map