/**
 * Per-conversation dedup memo for the Stop hook's citation detector.
 *
 * The Stop hook scans the full transcript every fire, so a long conversation
 * with repeated Stop firings would otherwise re-detect the same tool_use
 * citations every turn and double-count them in the citation log. This memo
 * holds the set of (conversationId, citedId) pairs already posted, so each
 * citation lands exactly once regardless of how many times Stop fires.
 *
 * Storage parallels the surfaced-memo (`memo.ts`): same state directory
 * (`~/.nlm/hook-state/`, overridable via NLM_HOOK_STATE_DIR), filename suffix
 * `.cited.json` to distinguish from the surfaced memo's `.json`. The existing
 * memo-sweep walks the directory by mtime and cleans both files together.
 *
 * Defensive: a missing or corrupt file yields an empty set; a write failure
 * is swallowed. Telemetry path — must never break the hook.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function stateDir() {
    return process.env["NLM_HOOK_STATE_DIR"] ?? join(homedir(), ".nlm", "hook-state");
}
function memoPath(conversationId) {
    const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
    return join(stateDir(), `${safe}.cited.json`);
}
export function loadCited(conversationId) {
    try {
        const path = memoPath(conversationId);
        if (!existsSync(path))
            return new Set();
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!Array.isArray(parsed))
            return new Set();
        return new Set(parsed.filter((x) => typeof x === "string"));
    }
    catch {
        return new Set();
    }
}
export function recordCited(conversationId, ids) {
    if (ids.length === 0)
        return;
    try {
        const merged = loadCited(conversationId);
        for (const id of ids)
            merged.add(id);
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(memoPath(conversationId), JSON.stringify([...merged]), "utf8");
    }
    catch {
        // Memo write failure must never break the hook.
    }
}
export function clearCited(conversationId) {
    try {
        const path = memoPath(conversationId);
        if (!existsSync(path))
            return false;
        rmSync(path);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=cite-memo.js.map