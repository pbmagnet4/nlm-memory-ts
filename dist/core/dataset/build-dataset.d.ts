/**
 * buildDataset — read projection over canonical.sqlite that hydrates every
 * UI page (pulse, river, search, thread).
 *
 * Ports the read paths of `dataset.py`. Action-driven overlays (dismissed
 * alerts, snoozed entities, retired labels, merged variants) are deferred:
 * the action log isn't yet exposed by the TS daemon. Returns persisted
 * state directly.
 */
import type { SessionStatus } from "../../shared/types.js";
export interface DatasetSession {
    readonly id: string;
    readonly date: string;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly label: string;
    readonly summary: string;
    readonly entities: ReadonlyArray<string>;
    readonly decisions: ReadonlyArray<string>;
    readonly open: ReadonlyArray<string>;
    readonly open_questions: ReadonlyArray<{
        id: string;
        text: string;
        resolved: false;
    }>;
    readonly status: SessionStatus;
    readonly duration_min: number;
    readonly runtime: string;
    readonly supersedes?: string;
    readonly superseded_by?: string;
}
export interface DatasetEntity {
    readonly canonical: string;
    readonly type: string;
    readonly status: string;
    readonly session_count: number;
    readonly last_seen_session: string | null;
}
export interface DatasetResponse {
    readonly meta: {
        readonly last_sync: string;
        readonly sessions_total: number;
        readonly entities_total: number;
        readonly db_present: boolean;
        readonly db_path: string;
    };
    readonly sessions: ReadonlyArray<DatasetSession>;
    readonly entities: ReadonlyArray<DatasetEntity>;
    readonly entity_colors: Record<string, string>;
    readonly entity_type: Record<string, string>;
    readonly entity_status: Record<string, string>;
    readonly metrics: {
        readonly this_week: number;
        readonly last_week: number;
        readonly sparkline: ReadonlyArray<number>;
        readonly healthy: number;
        readonly sparse: number;
        readonly stale: number;
        readonly closed_decisions: number;
    };
    readonly alerts: ReadonlyArray<{
        readonly id: string;
        readonly type: "stale";
        readonly severity: "high" | "medium";
        readonly entity: string;
        readonly summary: string;
        readonly sessions: ReadonlyArray<string>;
        readonly age_days: number;
        readonly last_touch_at: string | null;
    }>;
    readonly runtimes: ReadonlyArray<DatasetRuntime>;
}
export interface DatasetRuntime {
    readonly name: string;
    readonly status: "active" | "idle" | "dormant";
    readonly sessions_total: number;
    readonly this_week: number;
    readonly last_week: number;
    readonly last_session_at: string | null;
}
export interface BuildDatasetOptions {
    /** Include path-shaped entities (filesystem leaks from the classifier).
     *  Default false — they pollute the catalog without adding signal. */
    readonly includePaths?: boolean;
}
export declare function buildDataset(dbPath: string, options?: BuildDatasetOptions): DatasetResponse;
export declare function isPathShapedEntity(canonical: string): boolean;
