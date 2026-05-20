/**
 * live-status — derive the three-tier session status (active / idle / closed)
 * from a transcript file's mtime. Mirrors the Python daemon's
 * live_session_status(): explicit supersedence wins; missing file → closed;
 * otherwise bucketed by age.
 *
 * Thresholds match Python exactly:
 *   < 15 min       → active
 *   15 min – 24 h  → idle
 *   ≥ 24 h         → closed
 *
 * Pure function over filesystem mtime. Tested with synthetic file ages.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const ACTIVE_THRESHOLD_MS = 15 * 60 * 1000;
const IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
function expandHome(path) {
    if (path.startsWith("~/"))
        return join(homedir(), path.slice(2));
    return path;
}
export function liveSessionStatus(transcriptPath, persistedStatus, now = Date.now()) {
    if (persistedStatus === "superseded")
        return "superseded";
    if (!transcriptPath)
        return "closed";
    try {
        const expanded = expandHome(transcriptPath);
        const st = statSync(expanded);
        const ageMs = now - st.mtimeMs;
        if (ageMs < ACTIVE_THRESHOLD_MS)
            return "active";
        if (ageMs < IDLE_THRESHOLD_MS)
            return "idle";
        return "closed";
    }
    catch {
        return "closed";
    }
}
//# sourceMappingURL=live-status.js.map