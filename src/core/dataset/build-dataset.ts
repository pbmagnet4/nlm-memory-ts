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
import { liveSessionStatus } from "@core/storage/live-status.js";
import type { SessionStatus } from "@shared/types.js";

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
  readonly open_questions: ReadonlyArray<{ id: string; text: string; resolved: false }>;
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
}

interface SessionRow {
  id: string;
  started_at: string | null;
  ended_at: string | null;
  duration_min: number | null;
  label: string;
  summary: string;
  status: "active" | "closed" | "superseded";
  transcript_path: string | null;
  runtime: string;
}

interface EntityRow {
  session_id: string;
  entity_canonical: string;
}

interface MarkerRow {
  session_id: string;
  kind: "decision" | "open";
  text: string;
  position: number;
}

interface EdgeRow {
  from_session: string;
  to_session: string;
  kind: "supersedes" | "continues";
}

interface EntityCatalogRow {
  canonical: string;
  type: string;
  status: string;
  session_count: number;
  last_seen_session: string | null;
}

const EMPTY_DATASET = (dbPath: string, present: boolean): DatasetResponse => ({
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
});

export function buildDataset(dbPath: string): DatasetResponse {
  if (!existsSync(dbPath)) return EMPTY_DATASET(dbPath, false);
  const db = new Database(dbPath, { readonly: true });
  try {
    sqliteVec.load(db);
  } catch {
    // vec extension only required for semantic search; tolerable here.
  }
  try {
    return projectFromDb(db, dbPath);
  } finally {
    db.close();
  }
}

function projectFromDb(db: Database.Database, dbPath: string): DatasetResponse {
  const sessionRows = db
    .prepare<[], SessionRow>(`
      SELECT id, started_at, ended_at, duration_min, label, summary,
             status, transcript_path, runtime
      FROM sessions
      ORDER BY started_at ASC
    `)
    .all();

  if (sessionRows.length === 0) return EMPTY_DATASET(dbPath, true);

  const entitiesBySession = new Map<string, string[]>();
  for (const r of db
    .prepare<[], EntityRow>("SELECT session_id, entity_canonical FROM session_entities ORDER BY session_id")
    .all()) {
    const list = entitiesBySession.get(r.session_id);
    if (list) list.push(r.entity_canonical);
    else entitiesBySession.set(r.session_id, [r.entity_canonical]);
  }

  const decisionsBySession = new Map<string, string[]>();
  const openBySession = new Map<string, { id: string; text: string }[]>();
  for (const r of db
    .prepare<[], MarkerRow>("SELECT session_id, kind, text, position FROM markers ORDER BY session_id, position")
    .all()) {
    if (r.kind === "decision") {
      const list = decisionsBySession.get(r.session_id);
      if (list) list.push(r.text);
      else decisionsBySession.set(r.session_id, [r.text]);
    } else {
      const id = `${r.session_id}::${stableHash12(r.text)}`;
      const list = openBySession.get(r.session_id);
      if (list) list.push({ id, text: r.text });
      else openBySession.set(r.session_id, [{ id, text: r.text }]);
    }
  }

  const supersedesBy = new Map<string, string>();
  const supersededByBy = new Map<string, string>();
  const continuesBy = new Map<string, string>();
  for (const r of db
    .prepare<[], EdgeRow>("SELECT from_session, to_session, kind FROM session_edges")
    .all()) {
    if (r.kind === "supersedes") {
      supersedesBy.set(r.from_session, r.to_session);
      supersededByBy.set(r.to_session, r.from_session);
    } else if (r.kind === "continues") {
      continuesBy.set(r.from_session, r.to_session);
    }
  }

  const sessions: DatasetSession[] = sessionRows.map((s) => {
    const status = liveSessionStatus(s.transcript_path, s.status);
    const open = openBySession.get(s.id) ?? [];
    const supersedes = supersedesBy.get(s.id);
    const supersededBy = supersededByBy.get(s.id);
    return {
      id: s.id,
      date: (s.started_at ?? "").slice(0, 10),
      started_at: s.started_at,
      ended_at: s.ended_at,
      label: s.label,
      summary: s.summary,
      entities: entitiesBySession.get(s.id) ?? [],
      decisions: decisionsBySession.get(s.id) ?? [],
      open: open.map((o) => o.text),
      open_questions: open.map((o) => ({ id: o.id, text: o.text, resolved: false as const })),
      status,
      duration_min: s.duration_min ?? 0,
      runtime: s.runtime,
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(supersededBy !== undefined ? { superseded_by: supersededBy } : {}),
    };
  });

  // continuesBy is in the dataset shape but unused by current UI; reserved for thread view.
  void continuesBy;

  const entityRows = db
    .prepare<[], EntityCatalogRow>(`
      SELECT canonical, type, status, session_count, last_seen_session
      FROM entities ORDER BY session_count DESC
    `)
    .all();

  const overlay = loadActionOverlay(db);

  for (const e of entityRows) {
    if (overlay.retiredEntities.has(e.canonical)) e.status = "retired";
    else if (overlay.snoozedEntities.has(e.canonical)) e.status = "snoozed";
    const newType = overlay.labeledEntities.get(e.canonical);
    if (newType) e.type = newType;
  }

  const entityColors: Record<string, string> = {};
  const entityType: Record<string, string> = {};
  const entityStatus: Record<string, string> = {};
  for (const e of entityRows) {
    entityColors[e.canonical] = stableColor(e.canonical);
    entityType[e.canonical] = e.type;
    entityStatus[e.canonical] = e.status;
  }

  const metrics = computeMetrics(sessions, entityRows);
  const alerts = computeStaleAlerts(sessions, entityRows, overlay);

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
  };
}

function computeMetrics(
  sessions: ReadonlyArray<DatasetSession>,
  entityRows: ReadonlyArray<EntityCatalogRow>,
) {
  const now = Date.now();
  const sparkline = [0, 0, 0, 0, 0, 0, 0];
  let thisWeek = 0;
  let lastWeek = 0;
  for (const s of sessions) {
    const t = s.started_at ? Date.parse(s.started_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const ageDays = (now - t) / 86_400_000;
    if (ageDays >= 0 && ageDays < 7) {
      thisWeek += 1;
      const bucket = Math.min(6, Math.floor(ageDays));
      sparkline[6 - bucket] = (sparkline[6 - bucket] ?? 0) + 1;
    } else if (ageDays >= 7 && ageDays < 14) {
      lastWeek += 1;
    }
  }
  const sessionsById = new Map(sessions.map((s) => [s.id, s]));
  let healthy = 0;
  let sparse = 0;
  let stale = 0;
  for (const e of entityRows) {
    if (e.session_count === 0) continue;
    const last = sessionsById.get(e.last_seen_session ?? "");
    const lastT = last?.started_at ? Date.parse(last.started_at) : NaN;
    const ageDays = Number.isFinite(lastT) ? (now - lastT) / 86_400_000 : 999;
    if (ageDays > 30) stale += 1;
    else if (e.session_count >= 3) healthy += 1;
    else sparse += 1;
  }
  const closedDecisions = sessions.reduce(
    (sum, s) => sum + (s.status === "superseded" ? 0 : s.decisions.length),
    0,
  );
  return { this_week: thisWeek, last_week: lastWeek, sparkline, healthy, sparse, stale, closed_decisions: closedDecisions };
}

interface ActionOverlay {
  readonly dismissedAlerts: Set<string>;
  readonly snoozedAlerts: Map<string, string>; // alert id → snoozed_until ISO
  readonly retiredEntities: Set<string>;
  readonly snoozedEntities: Map<string, string>; // canonical → snoozed_until ISO
  readonly labeledEntities: Map<string, string>; // canonical → new type
}

interface ActionRow {
  kind: string;
  subject_type: string;
  subject_id: string;
  payload: string | null;
}

function loadActionOverlay(db: Database.Database): ActionOverlay {
  const overlay: ActionOverlay = {
    dismissedAlerts: new Set(),
    snoozedAlerts: new Map(),
    retiredEntities: new Set(),
    snoozedEntities: new Map(),
    labeledEntities: new Map(),
  };
  const hasActions = db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='actions'")
    .get();
  if (!hasActions) return overlay;

  const rows = db
    .prepare<[], ActionRow>(`
      SELECT kind, subject_type, subject_id, payload
      FROM actions
      WHERE reverted_by IS NULL
    `)
    .all();

  const now = new Date().toISOString();
  for (const r of rows) {
    const payload = r.payload ? (safeParse(r.payload) as Record<string, unknown> | null) : null;
    if (r.kind === "dismiss" && r.subject_type === "alert") overlay.dismissedAlerts.add(r.subject_id);
    else if (r.kind === "snooze" && r.subject_type === "alert") {
      const until = typeof payload?.["snoozed_until"] === "string" ? payload["snoozed_until"] : "";
      if (until > now) overlay.snoozedAlerts.set(r.subject_id, until);
    } else if (r.kind === "retire_entity" && r.subject_type === "entity") overlay.retiredEntities.add(r.subject_id);
    else if (r.kind === "snooze" && r.subject_type === "entity") {
      const until = typeof payload?.["snoozed_until"] === "string" ? payload["snoozed_until"] : "";
      if (until > now) overlay.snoozedEntities.set(r.subject_id, until);
    } else if (r.kind === "label_entity" && r.subject_type === "entity") {
      const newType = typeof payload?.["new_type"] === "string" ? payload["new_type"] : null;
      if (newType) overlay.labeledEntities.set(r.subject_id, newType);
    }
  }
  return overlay;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function computeStaleAlerts(
  sessions: ReadonlyArray<DatasetSession>,
  entityRows: ReadonlyArray<EntityCatalogRow>,
  overlay: ActionOverlay,
): DatasetResponse["alerts"] {
  const now = Date.now();
  const sessionsById = new Map(sessions.map((s) => [s.id, s]));
  const alerts: DatasetResponse["alerts"][number][] = [];
  for (const e of entityRows) {
    if (e.session_count === 0 || e.status === "retired" || e.status === "snoozed") continue;
    const last = sessionsById.get(e.last_seen_session ?? "");
    const lastT = last?.started_at ? Date.parse(last.started_at) : NaN;
    if (!Number.isFinite(lastT)) continue;
    const ageDays = Math.floor((now - lastT) / 86_400_000);
    if (ageDays <= 30) continue;

    const alertId = `stale_${e.canonical.replace(/[^A-Za-z0-9]/g, "_")}`;
    if (overlay.dismissedAlerts.has(alertId) || overlay.snoozedAlerts.has(alertId)) continue;

    const openOnEntity = sessions
      .filter((s) => s.entities.includes(e.canonical))
      .flatMap((s) => s.open)
      .slice(0, 2);
    let summary = `Last touch ${ageDays} days ago`;
    if (openOnEntity.length > 0) {
      const n = openOnEntity.length;
      const label = n === 1 ? "question" : "questions";
      summary += ` · ${n} unresolved open ${label}: "${openOnEntity[0]!.slice(0, 80)}"`;
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

function stableHash12(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, "0").slice(0, 12);
}

const HUES = [200, 270, 320, 30, 90, 150, 220, 290, 340, 50, 110, 170] as const;

function stableColor(canonical: string): string {
  let h = 0;
  for (let i = 0; i < canonical.length; i++) h = (h * 31 + canonical.charCodeAt(i)) | 0;
  const hue = HUES[Math.abs(h) % HUES.length] ?? 200;
  return `hsl(${hue}, 60%, 55%)`;
}
