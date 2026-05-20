/**
 * buildDataset — read projection over canonical.sqlite that hydrates every
 * UI page (pulse, river, search, thread).
 *
 * Ports the read paths of `dataset.py`. Action-driven overlays (dismissed
 * alerts, snoozed entities, retired labels, merged variants) are deferred:
 * the action log isn't yet exposed by the TS daemon. Returns persisted
 * state directly.
 */
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { liveSessionStatus } from "../storage/live-status.js";
import { loadActionOverlay, openQuestionId } from "../actions/overlay.js";
const EMPTY_DATASET = (dbPath, present) => ({
    meta: {
        last_sync: new Date().toISOString(),
        sessions_total: 0,
        entities_total: 0,
        db_present: present,
        db_path: dbPath,
    },
    sessions: [],
    entities: [],
    entity_colors: {},
    entity_type: {},
    entity_status: {},
    metrics: { this_week: 0, last_week: 0, sparkline: [0, 0, 0, 0, 0, 0, 0], healthy: 0, sparse: 0, stale: 0, closed_decisions: 0 },
    alerts: [],
    runtimes: [],
});
export function buildDataset(dbPath, options = {}) {
    if (!existsSync(dbPath))
        return EMPTY_DATASET(dbPath, false);
    const db = new Database(dbPath, { readonly: true });
    try {
        sqliteVec.load(db);
    }
    catch {
        // vec extension only required for semantic search; tolerable here.
    }
    try {
        return projectFromDb(db, dbPath, options.includePaths ?? false);
    }
    finally {
        db.close();
    }
}
/**
 * Heuristic for "this entity is actually a filesystem path the classifier
 * leaked into the catalog". Catches things like ".claude/agents/",
 * "bridge/server.js", "deploy.sh", "nlm-memory-spec.md" while leaving
 * real entities like "n8n", "Node.js", "NocoDB", "personal-workspace" alone.
 */
const CODE_FILE_EXT_RE = /\.(?:md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|py|pyi|json|yaml|yml|toml|sh|bash|zsh|css|html|sql|xml|env|ini|cfg|conf|lock)$/i;
export function isPathShapedEntity(canonical) {
    if (!canonical)
        return false;
    // Any slash → looks like a path (forward or back).
    if (canonical.includes("/") || canonical.includes("\\"))
        return true;
    // Hidden-file prefix only when it's clearly a dotfile (e.g. ".env", ".mcp.json").
    if (canonical.startsWith(".") && canonical.length > 1 && canonical !== "...")
        return true;
    // Common source-code file extensions.
    if (CODE_FILE_EXT_RE.test(canonical))
        return true;
    return false;
}
function projectFromDb(db, dbPath, includePaths) {
    const sessionRows = db
        .prepare(`
      SELECT id, started_at, ended_at, duration_min, label, summary,
             status, transcript_path, runtime
      FROM sessions
      ORDER BY started_at ASC
    `)
        .all();
    if (sessionRows.length === 0)
        return EMPTY_DATASET(dbPath, true);
    const entitiesBySession = new Map();
    for (const r of db
        .prepare("SELECT session_id, entity_canonical FROM session_entities ORDER BY session_id")
        .all()) {
        const list = entitiesBySession.get(r.session_id);
        if (list)
            list.push(r.entity_canonical);
        else
            entitiesBySession.set(r.session_id, [r.entity_canonical]);
    }
    const decisionsBySession = new Map();
    const openBySession = new Map();
    for (const r of db
        .prepare("SELECT session_id, kind, text, position FROM markers ORDER BY session_id, position")
        .all()) {
        if (r.kind === "decision") {
            const list = decisionsBySession.get(r.session_id);
            if (list)
                list.push(r.text);
            else
                decisionsBySession.set(r.session_id, [r.text]);
        }
        else {
            const id = openQuestionId(r.session_id, r.text);
            const list = openBySession.get(r.session_id);
            if (list)
                list.push({ id, text: r.text });
            else
                openBySession.set(r.session_id, [{ id, text: r.text }]);
        }
    }
    const supersedesBy = new Map();
    const supersededByBy = new Map();
    const continuesBy = new Map();
    for (const r of db
        .prepare("SELECT from_session, to_session, kind FROM session_edges")
        .all()) {
        if (r.kind === "supersedes") {
            supersedesBy.set(r.from_session, r.to_session);
            supersededByBy.set(r.to_session, r.from_session);
        }
        else if (r.kind === "continues") {
            continuesBy.set(r.from_session, r.to_session);
        }
    }
    const allEntityRows = db
        .prepare(`
      SELECT canonical, type, status, session_count, last_seen_session
      FROM entities ORDER BY session_count DESC
    `)
        .all();
    const overlay = loadActionOverlay(db);
    for (const e of allEntityRows) {
        if (overlay.retiredEntities.has(e.canonical))
            e.status = "retired";
        else if (overlay.snoozedEntities.has(e.canonical))
            e.status = "snoozed";
        const newType = overlay.labeledEntities.get(e.canonical);
        if (newType)
            e.type = newType;
    }
    const entityRows = includePaths
        ? allEntityRows
        : allEntityRows.filter((e) => !isPathShapedEntity(e.canonical));
    const keptEntities = new Set(entityRows.map((e) => e.canonical));
    const sessions = sessionRows.map((s) => {
        const status = liveSessionStatus(s.transcript_path, s.status);
        const rawOpen = openBySession.get(s.id) ?? [];
        const supersedes = supersedesBy.get(s.id);
        const supersededBy = supersededByBy.get(s.id);
        const rawEntities = entitiesBySession.get(s.id) ?? [];
        const activeOpen = rawOpen.filter((o) => !overlay.resolvedOpens.has(o.id) && !overlay.promotedOpens.has(o.id));
        const promotedDecisions = rawOpen
            .filter((o) => overlay.promotedOpens.has(o.id))
            .map((o) => overlay.promotedOpens.get(o.id));
        return {
            id: s.id,
            date: (s.started_at ?? "").slice(0, 10),
            started_at: s.started_at,
            ended_at: s.ended_at,
            label: s.label,
            summary: s.summary,
            entities: includePaths ? rawEntities : rawEntities.filter((name) => keptEntities.has(name)),
            decisions: [...(decisionsBySession.get(s.id) ?? []), ...promotedDecisions],
            open: activeOpen.map((o) => o.text),
            open_questions: activeOpen.map((o) => ({ id: o.id, text: o.text, resolved: false })),
            status,
            duration_min: s.duration_min ?? 0,
            runtime: s.runtime,
            ...(supersedes !== undefined ? { supersedes } : {}),
            ...(supersededBy !== undefined ? { superseded_by: supersededBy } : {}),
        };
    });
    // continuesBy is in the dataset shape but unused by current UI; reserved for thread view.
    void continuesBy;
    const entityColors = {};
    const entityType = {};
    const entityStatus = {};
    for (const e of entityRows) {
        entityColors[e.canonical] = stableColor(e.canonical);
        entityType[e.canonical] = e.type;
        entityStatus[e.canonical] = e.status;
    }
    const metrics = computeMetrics(sessions, entityRows);
    const alerts = computeStaleAlerts(sessions, entityRows, overlay);
    const runtimes = computeRuntimes(sessions);
    return {
        meta: {
            last_sync: new Date().toISOString(),
            sessions_total: sessions.length,
            entities_total: entityRows.length,
            db_present: true,
            db_path: dbPath,
        },
        sessions,
        entities: entityRows,
        entity_colors: entityColors,
        entity_type: entityType,
        entity_status: entityStatus,
        metrics,
        alerts,
        runtimes,
    };
}
function computeRuntimes(sessions) {
    const now = Date.now();
    const day = 86_400_000;
    const week = now - 7 * day;
    const prev = now - 14 * day;
    const groups = new Map();
    for (const s of sessions) {
        const name = (s.runtime ?? "").trim() || "unknown";
        const g = groups.get(name) ?? { total: 0, thisWeek: 0, lastWeek: 0, lastAt: 0, lastAtIso: null };
        g.total += 1;
        if (s.started_at) {
            const t = Date.parse(s.started_at);
            if (Number.isFinite(t)) {
                if (t >= week)
                    g.thisWeek += 1;
                else if (t >= prev)
                    g.lastWeek += 1;
                if (t > g.lastAt) {
                    g.lastAt = t;
                    g.lastAtIso = s.started_at;
                }
            }
        }
        groups.set(name, g);
    }
    const hour = 3_600_000;
    const out = [];
    for (const [name, g] of groups) {
        const age = g.lastAt ? now - g.lastAt : Infinity;
        const status = age <= hour ? "active" : age <= day ? "idle" : "dormant";
        out.push({
            name,
            status,
            sessions_total: g.total,
            this_week: g.thisWeek,
            last_week: g.lastWeek,
            last_session_at: g.lastAtIso,
        });
    }
    out.sort((a, b) => (Date.parse(b.last_session_at ?? "0") || 0) - (Date.parse(a.last_session_at ?? "0") || 0));
    return out;
}
function computeMetrics(sessions, entityRows) {
    const now = Date.now();
    const sparkline = [0, 0, 0, 0, 0, 0, 0];
    let thisWeek = 0;
    let lastWeek = 0;
    for (const s of sessions) {
        const t = s.started_at ? Date.parse(s.started_at) : NaN;
        if (!Number.isFinite(t))
            continue;
        const ageDays = (now - t) / 86_400_000;
        if (ageDays >= 0 && ageDays < 7) {
            thisWeek += 1;
            const bucket = Math.min(6, Math.floor(ageDays));
            sparkline[6 - bucket] = (sparkline[6 - bucket] ?? 0) + 1;
        }
        else if (ageDays >= 7 && ageDays < 14) {
            lastWeek += 1;
        }
    }
    const sessionsById = new Map(sessions.map((s) => [s.id, s]));
    let healthy = 0;
    let sparse = 0;
    let stale = 0;
    for (const e of entityRows) {
        if (e.session_count === 0)
            continue;
        const last = sessionsById.get(e.last_seen_session ?? "");
        const lastT = last?.started_at ? Date.parse(last.started_at) : NaN;
        const ageDays = Number.isFinite(lastT) ? (now - lastT) / 86_400_000 : 999;
        if (ageDays > 30)
            stale += 1;
        else if (e.session_count >= 3)
            healthy += 1;
        else
            sparse += 1;
    }
    const closedDecisions = sessions.reduce((sum, s) => sum + (s.status === "superseded" ? 0 : s.decisions.length), 0);
    return { this_week: thisWeek, last_week: lastWeek, sparkline, healthy, sparse, stale, closed_decisions: closedDecisions };
}
function computeStaleAlerts(sessions, entityRows, overlay) {
    const now = Date.now();
    const sessionsById = new Map(sessions.map((s) => [s.id, s]));
    const alerts = [];
    for (const e of entityRows) {
        if (e.session_count === 0 || e.status === "retired" || e.status === "snoozed")
            continue;
        const last = sessionsById.get(e.last_seen_session ?? "");
        const lastT = last?.started_at ? Date.parse(last.started_at) : NaN;
        if (!Number.isFinite(lastT))
            continue;
        const ageDays = Math.floor((now - lastT) / 86_400_000);
        if (ageDays <= 30)
            continue;
        const alertId = `stale_${e.canonical.replace(/[^A-Za-z0-9]/g, "_")}`;
        if (overlay.dismissedAlerts.has(alertId) || overlay.snoozedAlerts.has(alertId))
            continue;
        const openOnEntity = sessions
            .filter((s) => s.entities.includes(e.canonical))
            .flatMap((s) => s.open)
            .slice(0, 2);
        let summary = `Last touch ${ageDays} days ago`;
        if (openOnEntity.length > 0) {
            const n = openOnEntity.length;
            const label = n === 1 ? "question" : "questions";
            summary += ` · ${n} unresolved open ${label}: "${openOnEntity[0].slice(0, 80)}"`;
        }
        alerts.push({
            id: alertId,
            type: "stale",
            severity: ageDays > 60 ? "high" : "medium",
            entity: e.canonical,
            summary,
            sessions: last ? [last.id] : [],
            age_days: ageDays,
            last_touch_at: last?.started_at ?? null,
        });
    }
    alerts.sort((a, b) => (a.severity === "high" ? 0 : 1) - (b.severity === "high" ? 0 : 1));
    return alerts;
}
const HUES = [200, 270, 320, 30, 90, 150, 220, 290, 340, 50, 110, 170];
function stableColor(canonical) {
    let h = 0;
    for (let i = 0; i < canonical.length; i++)
        h = (h * 31 + canonical.charCodeAt(i)) | 0;
    const hue = HUES[Math.abs(h) % HUES.length] ?? 200;
    return `hsl(${hue}, 60%, 55%)`;
}
//# sourceMappingURL=build-dataset.js.map