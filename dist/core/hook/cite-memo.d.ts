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
export declare function loadCited(conversationId: string): Set<string>;
export declare function recordCited(conversationId: string, ids: ReadonlyArray<string>): void;
export declare function clearCited(conversationId: string): boolean;
