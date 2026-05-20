/**
 * Session-list filters used before scoring.
 *
 * Pure function over a session array. Mirrors recall.py:_apply_filters.
 */
import type { Session, RecallKindFilter } from "../../shared/types.js";
export interface RecallFilter {
    readonly entity?: string;
    readonly kind?: RecallKindFilter;
}
export declare function applyFilter(sessions: ReadonlyArray<Session>, filter: RecallFilter): ReadonlyArray<Session>;
