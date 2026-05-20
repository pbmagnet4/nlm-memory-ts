/**
 * actions-log — append-only event source for every interactive change.
 *
 * The actions table is canonical: dismiss/snooze/retire/label/merge are
 * all rows here, never destructive mutations elsewhere. Dataset projection
 * (build-dataset.ts) reads this table to overlay user-driven state on top
 * of the persisted store. Ports server.py's _write_action + undo flow.
 */
import type Database from "better-sqlite3";
export interface ActionInput {
    readonly kind: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly payload?: Record<string, unknown>;
    readonly actor?: string;
    readonly runtime?: string;
}
export interface ActionRow {
    readonly id: string;
    readonly timestamp: string;
    readonly kind: string;
    readonly subject_type: string;
    readonly subject_id: string;
    readonly payload: Record<string, unknown> | null;
    readonly actor: string;
    readonly runtime: string | null;
    readonly reverted_by: string | null;
}
export declare function writeAction(db: Database.Database, input: ActionInput): string;
export declare function writeActionsBatch(db: Database.Database, inputs: ReadonlyArray<ActionInput>): string[];
export interface UndoResult {
    readonly undoId: string;
    readonly originalKind: string;
}
export declare function undoAction(db: Database.Database, actionId: string): UndoResult | null;
export declare function listActions(db: Database.Database, opts?: {
    limit?: number;
    subjectId?: string;
    kind?: string;
}): ActionRow[];
