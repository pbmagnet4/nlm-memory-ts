/**
 * actions-log — append-only event source for every interactive change.
 *
 * The actions table is canonical: dismiss/snooze/retire/label/merge are
 * all rows here, never destructive mutations elsewhere. Dataset projection
 * (build-dataset.ts) reads this table to overlay user-driven state on top
 * of the persisted store. Ports server.py's _write_action + undo flow.
 */
function makeActionId() {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = Math.random().toString(16).slice(2, 10);
    return `act_${ts}_${rand}`;
}
export function writeAction(db, input) {
    const id = makeActionId();
    const payload = input.payload ? JSON.stringify(input.payload) : null;
    db.prepare(`
    INSERT INTO actions (id, timestamp, kind, subject_type, subject_id, payload, actor, runtime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, new Date().toISOString(), input.kind, input.subjectType, input.subjectId, payload, input.actor ?? "user", input.runtime ?? "api");
    return id;
}
export function writeActionsBatch(db, inputs) {
    const txn = db.transaction((rows) => rows.map((r) => writeAction(db, r)));
    return txn(inputs);
}
export function undoAction(db, actionId) {
    const target = db
        .prepare("SELECT id, kind, subject_type, subject_id FROM actions WHERE id = ? AND reverted_by IS NULL")
        .get(actionId);
    if (!target)
        return null;
    const undoId = makeActionId();
    const undoPayload = JSON.stringify({
        undone_kind: target.kind,
        undone_subject: `${target.subject_type}:${target.subject_id}`,
    });
    const txn = db.transaction(() => {
        db.prepare(`
      INSERT INTO actions (id, timestamp, kind, subject_type, subject_id, payload, actor, runtime)
      VALUES (?, ?, 'undo', 'action', ?, ?, 'user', 'api')
    `).run(undoId, new Date().toISOString(), actionId, undoPayload);
        db.prepare("UPDATE actions SET reverted_by = ? WHERE id = ?").run(undoId, actionId);
    });
    txn();
    return { undoId, originalKind: target.kind };
}
export function listActions(db, opts = {}) {
    const limit = opts.limit ?? 100;
    const where = [];
    const params = [];
    if (opts.subjectId) {
        where.push("subject_id = ?");
        params.push(opts.subjectId);
    }
    if (opts.kind) {
        where.push("kind = ?");
        params.push(opts.kind);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
    SELECT id, timestamp, kind, subject_type, subject_id, payload, actor, runtime, reverted_by
    FROM actions
    ${whereSql}
    ORDER BY timestamp DESC
    LIMIT ?
  `;
    params.push(limit);
    const rows = db.prepare(sql).all(...params);
    return rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
}
//# sourceMappingURL=actions-log.js.map