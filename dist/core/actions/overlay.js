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
export const EMPTY_OVERLAY = {
    dismissedAlerts: new Set(),
    snoozedAlerts: new Map(),
    retiredEntities: new Set(),
    snoozedEntities: new Map(),
    labeledEntities: new Map(),
    resolvedOpens: new Set(),
    promotedOpens: new Map(),
};
export function loadActionOverlay(db) {
    const hasActions = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='actions'")
        .get();
    if (!hasActions)
        return EMPTY_OVERLAY;
    const overlay = {
        dismissedAlerts: new Set(),
        snoozedAlerts: new Map(),
        retiredEntities: new Set(),
        snoozedEntities: new Map(),
        labeledEntities: new Map(),
        resolvedOpens: new Set(),
        promotedOpens: new Map(),
    };
    const rows = db
        .prepare(`
      SELECT kind, subject_type, subject_id, payload
      FROM actions
      WHERE reverted_by IS NULL
    `)
        .all();
    const now = new Date().toISOString();
    for (const r of rows) {
        const payload = r.payload ? safeParse(r.payload) : null;
        if (r.kind === "dismiss" && r.subject_type === "alert") {
            overlay.dismissedAlerts.add(r.subject_id);
        }
        else if (r.kind === "snooze" && r.subject_type === "alert") {
            const until = typeof payload?.["snoozed_until"] === "string" ? payload["snoozed_until"] : "";
            if (until > now)
                overlay.snoozedAlerts.set(r.subject_id, until);
        }
        else if (r.kind === "retire_entity" && r.subject_type === "entity") {
            overlay.retiredEntities.add(r.subject_id);
        }
        else if (r.kind === "snooze" && r.subject_type === "entity") {
            const until = typeof payload?.["snoozed_until"] === "string" ? payload["snoozed_until"] : "";
            if (until > now)
                overlay.snoozedEntities.set(r.subject_id, until);
        }
        else if (r.kind === "label_entity" && r.subject_type === "entity") {
            const newType = typeof payload?.["new_type"] === "string" ? payload["new_type"] : null;
            if (newType)
                overlay.labeledEntities.set(r.subject_id, newType);
        }
        else if (r.kind === "resolve_open" && r.subject_type === "open_question") {
            overlay.resolvedOpens.add(r.subject_id);
        }
        else if (r.kind === "promote_open" && r.subject_type === "open_question") {
            const resolution = typeof payload?.["resolution"] === "string" ? payload["resolution"].trim() : "";
            if (resolution)
                overlay.promotedOpens.set(r.subject_id, resolution);
        }
    }
    return overlay;
}
/**
 * Stable id for an open question: `${sessionId}::${hash12(text)}`. Both
 * sides (overlay creators and consumers) compute it the same way so action
 * subject_ids round-trip.
 */
export function openQuestionId(sessionId, text) {
    return `${sessionId}::${stableHash12(text)}`;
}
function stableHash12(text) {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < text.length; i++) {
        h ^= BigInt(text.charCodeAt(i));
        h = BigInt.asUintN(64, h * 0x100000001b3n);
    }
    return h.toString(16).padStart(16, "0").slice(0, 12);
}
function safeParse(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=overlay.js.map