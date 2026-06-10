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
import { loadActionOverlay, openQuestionId, decisionId } from "@core/actions/overlay.js";
import type { ActionOverlay } from "@core/actions/overlay.js";
import type { SessionStatus } from "@shared/types.js";
import { runCheapChecksOnSqlite } from "@core/integrity/check-invariants.js";

export interface DatasetSession {
  readonly id: string;
  readonly date: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly label: string;
  readonly summary: string;
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  /** Stable ids parallel to `decisions[]`. Same length and order; use to
   *  target overlay actions (dismiss_decision, revise_decision). */
  readonly decision_ids: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
  readonly open_questions: ReadonlyArray<{ id: string; text: string; resolved: false }>;
  readonly status: SessionStatus;
  readonly duration_min: number;
  readonly runtime: string;
  readonly supersedes?: string;
  readonly superseded_by?: string;
  /** Mechanical re-ingest relation (predecessor was re-parsed into this one).
   *  Distinct from supersedes so the Thread UI (#299) can collapse replaced
   *  predecessors behind an "earlier versions" affordance rather than dimming
   *  them as operator-rejected. */
  readonly replaces?: string;
  readonly replaced_by?: string;
}

export type TopicCoherence = "active" | "sparse" | "stale";

export interface DatasetEntity {
  readonly canonical: string;
  readonly type: string;
  readonly status: string;
  readonly session_count: number;
  readonly last_seen_session: string | null;
  /** Renamed display label from the action overlay; absent if not renamed. */
  readonly display?: string;
  /** Effective coherence bucket (override if user set one, else computed). */
  readonly coherence: TopicCoherence;
  /** Computed bucket from session_count + age, ignoring any override. Lets
   *  the UI show "would naturally be X" alongside the user assertion. */
  readonly coherence_computed: TopicCoherence;
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
  /** canonical → display label; only canonicals with an active rename appear. */
  readonly entity_display: Record<string, string>;
  readonly metrics: {
    readonly this_week: number;
    readonly last_week: number;
    readonly sparkline: ReadonlyArray<number>;
    readonly healthy: number;
    readonly sparse: number;
    readonly stale: number;
    readonly closed_decisions: number;
  };
  readonly alerts: ReadonlyArray<
    | {
        readonly id: string;
        readonly type: "stale";
        readonly severity: "high" | "medium" | "low";
        readonly entity: string;
        readonly summary: string;
        readonly sessions: ReadonlyArray<string>;
        readonly age_days: number;
        readonly last_touch_at: string | null;
      }
    | {
        readonly id: string;
        readonly type: "integrity";
        readonly severity: "high";
        readonly summary: string;
        readonly count: number;
        readonly sampleIds: ReadonlyArray<string>;
      }
  >;
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

interface SessionRow {
  id: string;
  started_at: string | null;
  ended_at: string | null;
  duration_min: number | null;
  label: string;
  summary: string;
  status: "active" | "closed" | "superseded" | "replaced";
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
  kind: "supersedes" | "replaces" | "continues";
}

interface EntityCatalogRow {
  canonical: string;
  type: string;
  status: string;
  session_count: number;
  last_seen_session: string | null;
  display?: string;
  // Populated in the entity-row enrichment pass before entityRows is shipped
  // out as DatasetEntity[]; the loop sets both fields on every row.
  coherence: TopicCoherence;
  coherence_computed: TopicCoherence;
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
  entity_display: {},
  metrics: { this_week: 0, last_week: 0, sparkline: [0, 0, 0, 0, 0, 0, 0], healthy: 0, sparse: 0, stale: 0, closed_decisions: 0 },
  alerts: [],
  runtimes: [],
});

export interface BuildDatasetOptions {
  /** Include path-shaped entities (filesystem leaks from the classifier).
   *  Default false — they pollute the catalog without adding signal. */
  readonly includePaths?: boolean;
}

export function buildDataset(dbPath: string, options: BuildDatasetOptions = {}): DatasetResponse {
  if (!existsSync(dbPath)) return EMPTY_DATASET(dbPath, false);
  const db = new Database(dbPath, { readonly: true });
  try {
    sqliteVec.load(db);
  } catch {
    // vec extension only required for semantic search; tolerable here.
  }
  try {
    return projectFromDb(db, dbPath, options.includePaths ?? false);
  } finally {
    db.close();
  }
}

/**
 * Heuristic for "this entity is actually a filesystem path the classifier
 * leaked into the catalog". Catches things like ".claude/agents/",
 * "bridge/server.js", "deploy.sh", "nlm-memory-spec.md" while leaving
 * real entities like "n8n", "Node.js", "NocoDB", "personal-workspace" alone.
 */
const CODE_FILE_EXT_RE =
  /\.(?:md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|py|pyi|json|yaml|yml|toml|sh|bash|zsh|css|html|sql|xml|env|ini|cfg|conf|lock)$/i;

export function isPathShapedEntity(canonical: string): boolean {
  if (!canonical) return false;
  // Any slash → looks like a path (forward or back).
  if (canonical.includes("/") || canonical.includes("\\")) return true;
  // Hidden-file prefix only when it's clearly a dotfile (e.g. ".env", ".mcp.json").
  if (canonical.startsWith(".") && canonical.length > 1 && canonical !== "...") return true;
  // Common source-code file extensions.
  if (CODE_FILE_EXT_RE.test(canonical)) return true;
  return false;
}

function projectFromDb(db: Database.Database, dbPath: string, includePaths: boolean): DatasetResponse {
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
      const id = openQuestionId(r.session_id, r.text);
      const list = openBySession.get(r.session_id);
      if (list) list.push({ id, text: r.text });
      else openBySession.set(r.session_id, [{ id, text: r.text }]);
    }
  }

  const supersedesBy = new Map<string, string>();
  const supersededByBy = new Map<string, string>();
  const replacesBy = new Map<string, string>();
  const replacedByBy = new Map<string, string>();
  const continuesBy = new Map<string, string>();
  for (const r of db
    .prepare<[], EdgeRow>("SELECT from_session, to_session, kind FROM session_edges")
    .all()) {
    if (r.kind === "supersedes") {
      supersedesBy.set(r.from_session, r.to_session);
      supersededByBy.set(r.to_session, r.from_session);
    } else if (r.kind === "replaces") {
      replacesBy.set(r.from_session, r.to_session);
      replacedByBy.set(r.to_session, r.from_session);
    } else if (r.kind === "continues") {
      continuesBy.set(r.from_session, r.to_session);
    }
  }

  const allEntityRows = db
    .prepare<[], EntityCatalogRow>(`
      SELECT canonical, type, status, session_count, last_seen_session
      FROM entities ORDER BY session_count DESC
    `)
    .all();

  const overlay = loadActionOverlay(db);

  // Count-folding pass (Option B): runs before coherence computation so the
  // target entity's bucket reflects the absorbed session count.
  if (overlay.mergedEntities.size > 0) {
    const byCanonical = new Map(allEntityRows.map((e) => [e.canonical, e]));
    for (const [source, into] of overlay.mergedEntities) {
      const src = byCanonical.get(source);
      const tgt = byCanonical.get(into);
      if (src && tgt) tgt.session_count += src.session_count;
    }
  }

  const sessionStartByIdForCoherence = new Map<string, string | null>(
    sessionRows.map((s) => [s.id, s.started_at]),
  );
  const nowMs = Date.now();
  for (const e of allEntityRows) {
    if (overlay.retiredEntities.has(e.canonical) || overlay.mergedEntities.has(e.canonical)) e.status = "retired";
    else if (overlay.snoozedEntities.has(e.canonical)) e.status = "snoozed";
    const newType = overlay.labeledEntities.get(e.canonical);
    if (newType) e.type = newType;
    const newDisplay = overlay.renamedEntities.get(e.canonical);
    if (newDisplay) e.display = newDisplay;
    e.coherence_computed = computeCoherence(e, sessionStartByIdForCoherence, nowMs);
    e.coherence = overlay.coherenceOverrides.get(e.canonical) ?? e.coherence_computed;
  }

  const entityRows = includePaths
    ? allEntityRows
    : allEntityRows.filter((e) => !isPathShapedEntity(e.canonical));
  const keptEntities = new Set(entityRows.map((e) => e.canonical));

  const sessions: DatasetSession[] = sessionRows.map((s) => {
    const status = liveSessionStatus(s.transcript_path, s.status);
    const rawOpen = openBySession.get(s.id) ?? [];
    const supersedes = supersedesBy.get(s.id);
    const supersededBy = supersededByBy.get(s.id);
    const replaces = replacesBy.get(s.id);
    const replacedBy = replacedByBy.get(s.id);
    const rawEntities = entitiesBySession.get(s.id) ?? [];
    const activeOpen = rawOpen.filter(
      (o) => !overlay.resolvedOpens.has(o.id) && !overlay.promotedOpens.has(o.id),
    );
    const promotedDecisions = rawOpen
      .filter((o) => overlay.promotedOpens.has(o.id))
      .map((o) => overlay.promotedOpens.get(o.id)!);

    // Project decision overlays: dismissed lines drop out; revised lines
    // show the corrected text. Promoted-from-open lines pass through as-is
    // (the open-question id already governs them).
    const rawDecisions = decisionsBySession.get(s.id) ?? [];
    const projectedDecisions: string[] = [];
    const projectedDecisionIds: string[] = [];
    for (const text of rawDecisions) {
      const id = decisionId(s.id, text);
      if (overlay.dismissedDecisions.has(id)) continue;
      const revised = overlay.revisedDecisions.get(id);
      projectedDecisions.push(revised ?? text);
      projectedDecisionIds.push(id);
    }
    for (const text of promotedDecisions) {
      projectedDecisions.push(text);
      projectedDecisionIds.push(decisionId(s.id, text));
    }

    return {
      id: s.id,
      date: (s.started_at ?? "").slice(0, 10),
      started_at: s.started_at,
      ended_at: s.ended_at,
      label: s.label,
      summary: s.summary,
      entities: includePaths ? rawEntities : rawEntities.filter((name) => keptEntities.has(name)),
      decisions: projectedDecisions,
      decision_ids: projectedDecisionIds,
      open: activeOpen.map((o) => o.text),
      open_questions: activeOpen.map((o) => ({ id: o.id, text: o.text, resolved: false as const })),
      status,
      duration_min: s.duration_min ?? 0,
      runtime: s.runtime,
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(supersededBy !== undefined ? { superseded_by: supersededBy } : {}),
      ...(replaces !== undefined ? { replaces } : {}),
      ...(replacedBy !== undefined ? { replaced_by: replacedBy } : {}),
    };
  });

  // continuesBy is in the dataset shape but unused by current UI; reserved for thread view.
  void continuesBy;

  const entityColors: Record<string, string> = {};
  const entityType: Record<string, string> = {};
  const entityStatus: Record<string, string> = {};
  const entityDisplay: Record<string, string> = {};
  for (const e of entityRows) {
    entityColors[e.canonical] = stableColor(e.canonical);
    entityType[e.canonical] = e.type;
    entityStatus[e.canonical] = e.status;
    if (e.display) entityDisplay[e.canonical] = e.display;
  }

  const metrics = computeMetrics(sessions, entityRows);
  const staleAlerts = computeStaleAlerts(sessions, entityRows, overlay);
  const integrityAlerts = computeIntegrityAlerts(db);
  const alerts = [...staleAlerts, ...integrityAlerts];
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
    entity_display: entityDisplay,
    metrics,
    alerts,
    runtimes,
  };
}

function computeRuntimes(sessions: ReadonlyArray<DatasetSession>): DatasetRuntime[] {
  const now = Date.now();
  const day = 86_400_000;
  const week = now - 7 * day;
  const prev = now - 14 * day;
  const groups = new Map<string, {
    total: number;
    thisWeek: number;
    lastWeek: number;
    lastAt: number;
    lastAtIso: string | null;
  }>();
  for (const s of sessions) {
    const name = (s.runtime ?? "").trim() || "unknown";
    const g = groups.get(name) ?? { total: 0, thisWeek: 0, lastWeek: 0, lastAt: 0, lastAtIso: null };
    g.total += 1;
    if (s.started_at) {
      const t = Date.parse(s.started_at);
      if (Number.isFinite(t)) {
        if (t >= week) g.thisWeek += 1;
        else if (t >= prev) g.lastWeek += 1;
        if (t > g.lastAt) {
          g.lastAt = t;
          g.lastAtIso = s.started_at;
        }
      }
    }
    groups.set(name, g);
  }
  const hour = 3_600_000;
  const out: DatasetRuntime[] = [];
  for (const [name, g] of groups) {
    const age = g.lastAt ? now - g.lastAt : Infinity;
    const status: DatasetRuntime["status"] =
      age <= hour ? "active" : age <= day ? "idle" : "dormant";
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
  // Aggregate by the effective coherence (override wins, else computed) so
  // the headline bars match what the user sees after asserting a bucket.
  let healthy = 0;
  let sparse = 0;
  let stale = 0;
  for (const e of entityRows) {
    if (e.session_count === 0) continue;
    const bucket = e.coherence ?? "sparse";
    if (bucket === "stale") stale += 1;
    else if (bucket === "active") healthy += 1;
    else sparse += 1;
  }
  const closedDecisions = sessions.reduce(
    (sum, s) => sum + (s.status === "superseded" || s.status === "replaced" ? 0 : s.decisions.length),
    0,
  );
  return { this_week: thisWeek, last_week: lastWeek, sparkline, healthy, sparse, stale, closed_decisions: closedDecisions };
}

/** Natural coherence bucket for an entity, ignoring overlay overrides.
 *  Stale dominates: any topic last touched >30d is stale regardless of count. */
function computeCoherence(
  e: EntityCatalogRow,
  startedAtBySession: Map<string, string | null>,
  nowMs: number,
): TopicCoherence {
  if (e.session_count === 0) return "sparse";
  const startedAt = startedAtBySession.get(e.last_seen_session ?? "") ?? null;
  const lastT = startedAt ? Date.parse(startedAt) : NaN;
  const ageDays = Number.isFinite(lastT) ? (nowMs - lastT) / 86_400_000 : 999;
  if (ageDays > 30) return "stale";
  if (e.session_count >= 3) return "active";
  return "sparse";
}

type StaleAlert = Extract<DatasetResponse["alerts"][number], { type: "stale" }>;

function computeStaleAlerts(
  sessions: ReadonlyArray<DatasetSession>,
  entityRows: ReadonlyArray<EntityCatalogRow>,
  overlay: ActionOverlay,
): StaleAlert[] {
  const now = Date.now();
  const sessionsById = new Map(sessions.map((s) => [s.id, s]));
  const alerts: StaleAlert[] = [];
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
      severity: ageDays > 60 ? "high" : ageDays > 45 ? "medium" : "low",
      entity: e.canonical,
      summary,
      sessions: last ? [last.id] : [],
      age_days: ageDays,
      last_touch_at: last?.started_at ?? null,
    });
  }
  // high → medium → low, then secondary by age desc so older items surface first within a tier.
  const severityRank: Record<"high" | "medium" | "low", number> = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.age_days - a.age_days);
  return alerts;
}

function computeIntegrityAlerts(db: Database.Database): DatasetResponse["alerts"] {
  try {
    const violations = runCheapChecksOnSqlite(db);
    return violations.map((v) => ({
      id: `integrity_${v.id}`,
      type: "integrity" as const,
      severity: "high" as const,
      summary: `Integrity ${v.id}: ${v.description} (${v.count} instance${v.count === 1 ? "" : "s"})`,
      count: v.count,
      sampleIds: v.sampleIds,
    }));
  } catch {
    return [];
  }
}

const HUES = [200, 270, 320, 30, 90, 150, 220, 290, 340, 50, 110, 170] as const;

function stableColor(canonical: string): string {
  let h = 0;
  for (let i = 0; i < canonical.length; i++) h = (h * 31 + canonical.charCodeAt(i)) | 0;
  const hue = HUES[Math.abs(h) % HUES.length] ?? 200;
  return `hsl(${hue}, 60%, 55%)`;
}
