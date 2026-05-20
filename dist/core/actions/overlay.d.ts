/**
 * Action overlay loader. Reads the canonical action log and projects active
 * user-driven state (dismissed alerts, retired entities, snoozes, label
 * overrides, resolved/promoted open questions) so consumers can apply them
 * at read time without mutating the underlying store.
 *
 * Shared by buildDataset (UI projection) and SqliteSessionStore (recall
 * path), so the same overlay drives both surfaces. Append-only — every
 * mutation lives as a row in `actions`.
 */
import type Database from "better-sqlite3";
export interface ActionOverlay {
    readonly dismissedAlerts: Set<string>;
    readonly snoozedAlerts: Map<string, string>;
    readonly retiredEntities: Set<string>;
    readonly snoozedEntities: Map<string, string>;
    readonly labeledEntities: Map<string, string>;
    /** open-question ids resolved without becoming decisions */
    readonly resolvedOpens: Set<string>;
    /** open-question id → resolution text (becomes a decision at projection time) */
    readonly promotedOpens: Map<string, string>;
}
export declare const EMPTY_OVERLAY: ActionOverlay;
export declare function loadActionOverlay(db: Database.Database): ActionOverlay;
/**
 * Stable id for an open question: `${sessionId}::${hash12(text)}`. Both
 * sides (overlay creators and consumers) compute it the same way so action
 * subject_ids round-trip.
 */
export declare function openQuestionId(sessionId: string, text: string): string;
