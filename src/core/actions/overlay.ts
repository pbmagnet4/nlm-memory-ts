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
  readonly snoozedAlerts: Map<string, string>; // alert id → snoozed_until ISO
  readonly retiredEntities: Set<string>;
  readonly snoozedEntities: Map<string, string>;
  readonly labeledEntities: Map<string, string>;
  /** entity canonical → new display label. Storage canonical is untouched;
   *  legacy-name recall still resolves because sessions stay tagged with
   *  the original canonical. Last non-reverted rename per subject wins. */
  readonly renamedEntities: Map<string, string>;
  /** open-question ids resolved without becoming decisions */
  readonly resolvedOpens: Set<string>;
  /** open-question id → resolution text (becomes a decision at projection time) */
  readonly promotedOpens: Map<string, string>;
  /** decision ids hidden from the projection (the underlying session body keeps the original line). */
  readonly dismissedDecisions: Set<string>;
  /** decision id → corrected text shown in place of the original. */
  readonly revisedDecisions: Map<string, string>;
  /** entity canonical → user-asserted coherence bucket. Overrides the
   *  computed (session_count + age) classification at projection time;
   *  last non-reverted write wins. */
  readonly coherenceOverrides: Map<string, "active" | "sparse" | "stale">;
}

interface ActionRow {
  kind: string;
  subject_type: string;
  subject_id: string;
  payload: string | null;
}

export const EMPTY_OVERLAY: ActionOverlay = {
  dismissedAlerts: new Set(),
  snoozedAlerts: new Map(),
  retiredEntities: new Set(),
  snoozedEntities: new Map(),
  labeledEntities: new Map(),
  renamedEntities: new Map(),
  resolvedOpens: new Set(),
  promotedOpens: new Map(),
  dismissedDecisions: new Set(),
  revisedDecisions: new Map(),
  coherenceOverrides: new Map(),
};

export function loadActionOverlay(db: Database.Database): ActionOverlay {
  const hasActions = db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='actions'")
    .get();
  if (!hasActions) return EMPTY_OVERLAY;

  const overlay: ActionOverlay = {
    dismissedAlerts: new Set(),
    snoozedAlerts: new Map(),
    retiredEntities: new Set(),
    snoozedEntities: new Map(),
    labeledEntities: new Map(),
    renamedEntities: new Map(),
    resolvedOpens: new Set(),
    promotedOpens: new Map(),
    dismissedDecisions: new Set(),
    revisedDecisions: new Map(),
    coherenceOverrides: new Map(),
  };

  // ORDER BY id keeps reducer deterministic: later writes overwrite earlier
  // ones, so the latest non-reverted rename per subject wins.
  const rows = db
    .prepare<[], ActionRow>(`
      SELECT kind, subject_type, subject_id, payload
      FROM actions
      WHERE reverted_by IS NULL
      ORDER BY id
    `)
    .all();

  const now = new Date().toISOString();
  for (const r of rows) {
    const payload = r.payload ? (safeParse(r.payload) as Record<string, unknown> | null) : null;
    if (r.kind === "dismiss" && r.subject_type === "alert") {
      overlay.dismissedAlerts.add(r.subject_id);
    } else if (r.kind === "snooze" && r.subject_type === "alert") {
      const until = typeof payload?.["snoozed_until"] === "string" ? payload["snoozed_until"] : "";
      if (until > now) overlay.snoozedAlerts.set(r.subject_id, until);
    } else if (r.kind === "retire_entity" && r.subject_type === "entity") {
      overlay.retiredEntities.add(r.subject_id);
    } else if (r.kind === "snooze" && r.subject_type === "entity") {
      const until = typeof payload?.["snoozed_until"] === "string" ? payload["snoozed_until"] : "";
      if (until > now) overlay.snoozedEntities.set(r.subject_id, until);
    } else if (r.kind === "label_entity" && r.subject_type === "entity") {
      const newType = typeof payload?.["new_type"] === "string" ? payload["new_type"] : null;
      if (newType) overlay.labeledEntities.set(r.subject_id, newType);
    } else if (r.kind === "rename_entity" && r.subject_type === "entity") {
      const to = typeof payload?.["to"] === "string" ? payload["to"].trim() : "";
      if (to && to !== r.subject_id) overlay.renamedEntities.set(r.subject_id, to);
      else overlay.renamedEntities.delete(r.subject_id);
    } else if (r.kind === "resolve_open" && r.subject_type === "open_question") {
      overlay.resolvedOpens.add(r.subject_id);
    } else if (r.kind === "promote_open" && r.subject_type === "open_question") {
      const resolution = typeof payload?.["resolution"] === "string" ? payload["resolution"].trim() : "";
      if (resolution) overlay.promotedOpens.set(r.subject_id, resolution);
    } else if (r.kind === "dismiss_decision" && r.subject_type === "decision") {
      overlay.dismissedDecisions.add(r.subject_id);
    } else if (r.kind === "revise_decision" && r.subject_type === "decision") {
      const to = typeof payload?.["to"] === "string" ? payload["to"].trim() : "";
      if (to) overlay.revisedDecisions.set(r.subject_id, to);
      else overlay.revisedDecisions.delete(r.subject_id);
    } else if (r.kind === "set_coherence" && r.subject_type === "entity") {
      const state = typeof payload?.["state"] === "string" ? payload["state"] : "";
      if (state === "active" || state === "sparse" || state === "stale") {
        overlay.coherenceOverrides.set(r.subject_id, state);
      } else {
        // Empty payload reverts to the computed bucket.
        overlay.coherenceOverrides.delete(r.subject_id);
      }
    }
  }
  return overlay;
}

/**
 * Stable id for an open question: `${sessionId}::${hash12(text)}`. Both
 * sides (overlay creators and consumers) compute it the same way so action
 * subject_ids round-trip.
 */
export function openQuestionId(sessionId: string, text: string): string {
  return `${sessionId}::${stableHash12(text)}`;
}

/**
 * Stable id for a decision: `${sessionId}::dec::${hash12(text)}`. Same
 * deterministic-hash trick as open questions; the `dec::` infix keeps the
 * two ID spaces disjoint so a decision and an open question with the same
 * text in the same session don't collide.
 */
export function decisionId(sessionId: string, text: string): string {
  return `${sessionId}::dec::${stableHash12(text)}`;
}

function stableHash12(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, "0").slice(0, 12);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
