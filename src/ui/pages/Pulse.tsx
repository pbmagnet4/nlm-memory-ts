import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useDataset, relativeAge } from "../lib/dataset.js";
import type { DatasetAlert, DatasetEntity, DatasetRuntime, DatasetSession, TopicCoherence } from "../lib/dataset.js";
import { postAction } from "../lib/actions.js";
import { SessionDrawer } from "../components/SessionDrawer.js";
import { PromoteOpenButton } from "../components/PromoteOpenButton.js";
import { PulseSkeleton } from "../components/Skeleton.js";

type SeverityFilter = "all" | "high" | "medium" | "low";
type AlertSort = "oldest" | "recent";

export function PulsePage() {
  const { data, loading, error, refetch } = useDataset();
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [sort, setSort] = useState<AlertSort>("oldest");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [coherenceBucket, setCoherenceBucket] = useState<TopicCoherence | null>(null);

  const filteredAlerts = useMemo(() => {
    if (!data) return [];
    const filtered = severity === "all" ? data.alerts : data.alerts.filter((a) => a.severity === severity);
    return [...filtered].sort((a, b) => (sort === "oldest" ? b.age_days - a.age_days : a.age_days - b.age_days));
  }, [data, severity, sort]);

  const severityCounts = useMemo(() => {
    if (!data) return { all: 0, high: 0, medium: 0, low: 0 };
    return {
      all: data.alerts.length,
      high: data.alerts.filter((a) => a.severity === "high").length,
      medium: data.alerts.filter((a) => a.severity === "medium").length,
      low: data.alerts.filter((a) => a.severity === "low").length,
    };
  }, [data]);

  const dismissAlert = async (alertId: string) => {
    await postAction({ kind: "dismiss", subject_type: "alert", subject_id: alertId });
    await refetch();
  };
  const snoozeAlert = async (alertId: string, days: number) => {
    const until = new Date(Date.now() + days * 86_400_000).toISOString();
    await postAction({
      kind: "snooze",
      subject_type: "alert",
      subject_id: alertId,
      payload: { snoozed_until: until },
    });
    await refetch();
  };

  const recent = useMemo(() => {
    if (!data) return [];
    return [...data.sessions]
      .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
      .slice(0, 20);
  }, [data]);

  // Show the actual span of the displayed slice so the user knows the
  // window without us pretending it's a fixed cutoff (it's count-based).
  const recentSpan = useMemo(() => {
    const oldest = recent[recent.length - 1]?.started_at;
    if (!oldest) return null;
    const ms = Date.now() - Date.parse(oldest);
    if (!Number.isFinite(ms) || ms <= 0) return "last 24h";
    const hours = Math.floor(ms / 3_600_000);
    if (hours < 48) return "last 24h";
    const days = Math.floor(hours / 24);
    if (days < 30) return `last ${days}d`;
    const months = Math.floor(days / 30);
    if (months < 12) return `last ${months}mo`;
    return `last ${Math.floor(days / 365)}y`;
  }, [recent]);

  if (loading && !data) return <PulseSkeleton />;
  if (error && !data) return <div className="page-pad"><div className="muted error">{error}</div></div>;
  if (!data) return null;

  const detailAlert = detailId ? data.alerts.find((a) => a.id === detailId) ?? null : null;

  return (
    <div className="page-pad">
      <div className="kpi-row">
        <Kpi label="This week" value={data.metrics.this_week} hint={`${data.metrics.last_week} last week`} />
        <Kpi label="Sessions" value={data.meta.sessions_total} hint="total" />
        <Kpi label="Topics" value={data.meta.entities_total} hint="catalogued" />
        <Kpi label="Decisions" value={data.metrics.closed_decisions} hint="non-superseded" />
        <KpiSparkline values={data.metrics.sparkline} />
      </div>

      <div className="pulse-grid">
        <section className="card pulse-area-coherence">
          <header className="card-head"><h3>Topic Coherence</h3></header>
          <CoherenceBars
            metrics={data.metrics}
            onPick={(bucket) => setCoherenceBucket(bucket)}
          />
        </section>

        <section className="card pulse-area-runtimes">
          <header className="card-head"><h3>Runtimes</h3></header>
          <RuntimesPanel runtimes={data.runtimes} />
        </section>

        <section className="card pulse-scroll-card pulse-area-recent">
          <header className="card-head">
            <h3>Recent sessions</h3>
            {recentSpan && <span className="muted small">{recentSpan}</span>}
          </header>
          <div className="pulse-scroll-body">
            <ul className="session-list">
              {recent.map((s) => (
                <li
                  key={s.id}
                  className="session-row clickable"
                  onClick={() => setSessionId(s.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSessionId(s.id); } }}
                >
                  <span className={`chip-inline status-${s.status}`}>{s.status}</span>
                  <span className="session-label">{s.label}</span>
                  <span className="session-meta">{relativeAge(s.started_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="card pulse-scroll-card pulse-area-stale">
          <header className="card-head card-head-stack">
            <div className="card-head-row">
              <h3>Stale alerts</h3>
              <span className="muted small">
                {filteredAlerts.length}{filteredAlerts.length !== data.alerts.length ? ` / ${data.alerts.length}` : ""}
              </span>
            </div>
            <div className="card-filters">
              <div className="filter-group" role="group" aria-label="Severity">
                {(["all", "high", "medium", "low"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`chip${severity === s ? " active" : ""}`}
                    data-severity={s === "all" ? undefined : s}
                    aria-pressed={severity === s}
                    onClick={() => setSeverity(s)}
                  >{s} · {severityCounts[s]}</button>
                ))}
              </div>
              <div className="filter-group" role="group" aria-label="Sort">
                <button type="button" className={`chip${sort === "oldest" ? " active" : ""}`} onClick={() => setSort("oldest")}>oldest</button>
                <button type="button" className={`chip${sort === "recent" ? " active" : ""}`} onClick={() => setSort("recent")}>recent</button>
              </div>
            </div>
          </header>
          <div className="pulse-scroll-body">
            <ul className="alert-list">
              {filteredAlerts.map((a) => (
                <li
                  key={a.id}
                  className="alert-row clickable"
                  onClick={() => setDetailId(a.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetailId(a.id); } }}
                >
                  <span className={`chip-inline severity-${a.severity}`}>{a.severity}</span>
                  <span className="alert-entity" title={data.entity_display[a.entity] ? `Original: ${a.entity}` : undefined}>{data.entity_display[a.entity] ?? a.entity}</span>
                  <span className="alert-summary">{a.summary}</span>
                  <div className="alert-actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="chip" onClick={() => void snoozeAlert(a.id, 7)}>snooze 7d</button>
                    <button type="button" className="chip" onClick={() => void dismissAlert(a.id)}>dismiss</button>
                  </div>
                </li>
              ))}
              {filteredAlerts.length === 0 && (
                <li className="muted alert-row-empty">
                  {data.alerts.length === 0 ? "No stale alerts." : "No alerts match the current filters."}
                </li>
              )}
            </ul>
          </div>
        </section>
      </div>

      {detailAlert && (
        <AlertDrawer
          alert={detailAlert}
          entity={data.entities.find((e) => e.canonical === detailAlert.entity) ?? null}
          entityColor={data.entity_colors[detailAlert.entity] ?? "#666"}
          sessions={data.sessions}
          onClose={() => setDetailId(null)}
          onDismiss={async () => { await dismissAlert(detailAlert.id); setDetailId(null); }}
          onSnooze={async (days) => { await snoozeAlert(detailAlert.id, days); setDetailId(null); }}
          onPromoted={refetch}
        />
      )}

      {coherenceBucket && (
        <CoherenceDrawer
          bucket={coherenceBucket}
          entities={data.entities}
          entityColors={data.entity_colors}
          entityDisplay={data.entity_display}
          onClose={() => setCoherenceBucket(null)}
          onChanged={refetch}
        />
      )}

      {sessionId && (
        <SessionDrawer
          sessionId={sessionId}
          onClose={() => setSessionId(null)}
          entityColor={(() => {
            const s = data.sessions.find((x) => x.id === sessionId);
            const e = s?.entities[0];
            return e ? data.entity_colors[e] : undefined;
          })()}
        />
      )}
    </div>
  );
}

interface AlertDrawerProps {
  alert: DatasetAlert;
  entity: DatasetEntity | null;
  entityColor: string;
  sessions: DatasetSession[];
  onClose: () => void;
  onDismiss: () => Promise<void> | void;
  onSnooze: (days: number) => Promise<void> | void;
  onPromoted: () => Promise<void> | void;
}

const DRAWER_PAGE_SIZES = [10, 25, 50] as const;

function AlertDrawer({ alert, entity, entityColor, sessions, onClose, onDismiss, onSnooze, onPromoted }: AlertDrawerProps) {
  const navigate = useNavigate();
  const [pageSize, setPageSize] = useState<number>(10);
  const [page, setPage] = useState(0);

  const related = useMemo(() => {
    return sessions
      .filter((s) => s.entities.includes(alert.entity))
      .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  }, [sessions, alert.entity]);

  // Reset page when alert changes (drawer opened for a different entity) or page size changes.
  useEffect(() => { setPage(0); }, [alert.id, pageSize]);

  const pageCount = Math.max(1, Math.ceil(related.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const sessionSlice = related.slice(start, start + pageSize);

  const openQuestions = useMemo(
    () => related.flatMap((s) => s.open_questions.map((q) => ({ id: q.id, text: q.text, sid: s.id, when: s.started_at }))),
    [related],
  );

  const decisions = useMemo(
    () => related.flatMap((s) => s.decisions.map((d) => ({ text: d, sid: s.id, when: s.started_at }))),
    [related],
  );

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="session-drawer" role="dialog" aria-modal="true" aria-label={`Alert detail: ${entity?.display ?? alert.entity}`}>
        <header className="drawer-head">
          <span className="dot lg" style={{ background: entityColor }} />
          <h3 className="drawer-title" title={entity?.display ? `Original: ${alert.entity}` : undefined}>{entity?.display ?? alert.entity}</h3>
          <span className={`chip-inline severity-${alert.severity}`}>{alert.severity}</span>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="drawer-body">
          <p className="drawer-paragraph">{alert.summary}</p>

          <dl className="kv-list">
            <dt className="kv-label">Last touch</dt>
            <dd className="kv-value">{alert.age_days} day{alert.age_days === 1 ? "" : "s"} ago</dd>
            <dt className="kv-label">Last session</dt>
            <dd className="kv-value mono small">{alert.last_touch_at ?? "—"}</dd>
            {entity && (
              <>
                <dt className="kv-label">Topic type</dt>
                <dd className="kv-value">{entity.type}</dd>
                <dt className="kv-label">Total sessions</dt>
                <dd className="kv-value mono">{entity.session_count}</dd>
              </>
            )}
          </dl>

          <div className="drawer-actions">
            <button type="button" className="btn btn-accent" onClick={() => navigate(`/thread?entity=${encodeURIComponent(alert.entity)}`)}>
              Open thread
            </button>
            <button type="button" className="btn" onClick={() => void onSnooze(7)}>Snooze 7d</button>
            <button type="button" className="btn" onClick={() => void onSnooze(30)}>Snooze 30d</button>
            <button type="button" className="btn btn-danger" onClick={() => void onDismiss()}>Dismiss</button>
          </div>

          {openQuestions.length > 0 && (
            <>
              <h4 className="drawer-section">Open questions ({openQuestions.length})</h4>
              <ul className="drawer-list">
                {openQuestions.slice(0, 12).map((q, i) => (
                  <li key={`${q.id}-${i}`} className="marker-row-promotable">
                    <span className="live-tag" data-kind="open">open</span>
                    <span className="marker-text">{q.text}</span>
                    <PromoteOpenButton openId={q.id} defaultText={q.text} onPromoted={onPromoted} />
                    <span className="muted small">{relativeAge(q.when)}</span>
                  </li>
                ))}
              </ul>
              {openQuestions.length > 12 && <p className="muted small">Showing first 12 of {openQuestions.length}.</p>}
            </>
          )}

          {decisions.length > 0 && (
            <>
              <h4 className="drawer-section">Decisions ({decisions.length})</h4>
              <ul className="drawer-list">
                {decisions.slice(0, 8).map((d, i) => (
                  <li key={`${d.sid}-${i}`}>
                    <span className="live-tag" data-kind="decision">decision</span>
                    <span className="marker-text">{d.text}</span>
                    <span className="muted small">{relativeAge(d.when)}</span>
                  </li>
                ))}
              </ul>
              {decisions.length > 8 && <p className="muted small">Showing first 8 of {decisions.length}.</p>}
            </>
          )}

          <h4 className="drawer-section">Recent sessions ({related.length})</h4>
          <ul className="session-list">
            {sessionSlice.map((s) => (
              <li key={s.id} className="session-row">
                <span className={`chip-inline status-${s.status}`}>{s.status}</span>
                <div className="session-row-main">
                  <Link to={`/thread?entity=${encodeURIComponent(alert.entity)}&session=${encodeURIComponent(s.id)}`} className="session-label">{s.label}</Link>
                  <span className="session-meta">{s.summary}</span>
                </div>
                <span className="muted small mono">{relativeAge(s.started_at)}</span>
              </li>
            ))}
          </ul>
          {related.length > 0 && (
            <div className="pagination pagination-compact">
              <div className="page-size">
                <label className="form-label">Per page</label>
                <select
                  className="form-input form-input-inline"
                  value={pageSize}
                  onChange={(e) => setPageSize(Number.parseInt(e.target.value, 10))}
                >
                  {DRAWER_PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <span className="header-spacer" />
              <span className="muted small">
                {start + 1}–{Math.min(start + pageSize, related.length)} of {related.length}
              </span>
              <div className="page-nav">
                <button type="button" className="chip" disabled={currentPage === 0} onClick={() => setPage(0)}>«</button>
                <button type="button" className="chip" disabled={currentPage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹</button>
                <span className="page-indicator mono">{currentPage + 1} / {pageCount}</span>
                <button type="button" className="chip" disabled={currentPage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>›</button>
                <button type="button" className="chip" disabled={currentPage >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>»</button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function Kpi({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value.toLocaleString()}</span>
      {hint && <span className="kpi-hint">{hint}</span>}
    </div>
  );
}

function KpiSparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="kpi kpi-sparkline">
      <span className="kpi-label">Last 7 days</span>
      <div className="sparkline">
        {values.map((v, i) => (
          <span key={i} className="spark-bar" style={{ height: `${(v / max) * 100}%` }} title={`${v} sessions`} />
        ))}
      </div>
    </div>
  );
}

function CoherenceBars({
  metrics,
  onPick,
}: {
  metrics: { healthy: number; sparse: number; stale: number };
  onPick: (bucket: TopicCoherence) => void;
}) {
  const total = metrics.healthy + metrics.sparse + metrics.stale;
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  return (
    <div className="bar-stack">
      <Bar tone="active" label="Active" value={metrics.healthy} pct={pct(metrics.healthy)} onPick={() => onPick("active")} />
      <Bar tone="warn"   label="Sparse" value={metrics.sparse}  pct={pct(metrics.sparse)}  onPick={() => onPick("sparse")} />
      <Bar tone="danger" label="Stale"  value={metrics.stale}   pct={pct(metrics.stale)}   onPick={() => onPick("stale")} />
    </div>
  );
}

function RuntimesPanel({ runtimes }: { runtimes: DatasetRuntime[] }) {
  if (runtimes.length === 0) {
    return <div className="muted small" style={{ padding: "8px 12px" }}>No runtime activity yet.</div>;
  }
  return (
    <ul className="runtime-list">
      {runtimes.map((r) => (
        <li key={r.name} className="runtime-row">
          <span className={`runtime-dot runtime-${r.status}`} title={r.status} />
          <span className="runtime-name mono">{r.name}</span>
          <span className="runtime-counts muted small">
            {r.this_week}<span className="runtime-counts-sep">·</span><span className="runtime-counts-prev">{r.last_week} prev</span>
          </span>
          <span className="muted small mono runtime-age">{relativeAge(r.last_session_at)}</span>
        </li>
      ))}
    </ul>
  );
}

function Bar({ tone, label, value, pct, onPick }: {
  tone: "active" | "warn" | "danger";
  label: string;
  value: number;
  pct: number;
  onPick?: () => void;
}) {
  const rounded = Math.round(pct);
  const interactive = !!onPick && value > 0;
  return (
    <button
      type="button"
      className={`bar-item${interactive ? " bar-item-clickable" : ""}`}
      onClick={interactive ? onPick : undefined}
      disabled={!interactive}
      title={`${value.toLocaleString()} topic${value === 1 ? "" : "s"} · ${rounded}% of total${interactive ? " · click to review" : ""}`}
    >
      <span className="bar-label">{label}</span>
      <div className="bar-track">
        <div className={`bar-fill tone-${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="bar-value mono">{value.toLocaleString()}<span className="bar-pct muted small"> · {rounded}%</span></span>
    </button>
  );
}

const COHERENCE_TITLE: Record<TopicCoherence, string> = {
  active: "Active topics",
  sparse: "Sparse topics",
  stale: "Stale topics",
};

const COHERENCE_HINT: Record<TopicCoherence, string> = {
  active: "3+ sessions and touched within 30 days. Override if you want to mark it sparse or stale.",
  sparse: "Only 1–2 sessions but touched recently. Move to Active if it's actually a real topic.",
  stale: "Last touched more than 30 days ago. Move back to Active if you've picked it up again.",
};

function CoherenceDrawer({
  bucket,
  entities,
  entityColors,
  entityDisplay,
  onClose,
  onChanged,
}: {
  bucket: TopicCoherence;
  entities: DatasetEntity[];
  entityColors: Record<string, string>;
  entityDisplay: Record<string, string>;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  // Filter to the current bucket and sort by session count desc so the
  // most-loaded topics rise to the top within their bucket.
  const rows = useMemo(
    () => entities
      .filter((e) => e.coherence === bucket && e.session_count > 0)
      .sort((a, b) => b.session_count - a.session_count),
    [entities, bucket],
  );

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const setBucket = async (canonical: string, next: TopicCoherence | null) => {
    setBusy(canonical);
    try {
      await postAction({
        kind: "set_coherence",
        subject_type: "entity",
        subject_id: canonical,
        // Empty state reverts to the natural computed bucket.
        payload: next ? { state: next } : {},
      });
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="session-drawer coherence-drawer" role="dialog" aria-modal="true" aria-label={`${COHERENCE_TITLE[bucket]} review`}>
        <header className="drawer-head">
          <h3 className="drawer-title">{COHERENCE_TITLE[bucket]}</h3>
          <span className="muted small">{rows.length.toLocaleString()}</span>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="drawer-body">
          <p className="drawer-paragraph muted small">{COHERENCE_HINT[bucket]}</p>
          <ul className="coherence-list">
            {rows.map((e) => {
              const label = entityDisplay[e.canonical] ?? e.canonical;
              const overridden = e.coherence !== e.coherence_computed;
              const rowBusy = busy === e.canonical;
              return (
                <li key={e.canonical} className="coherence-row">
                  <span className="dot" style={{ background: entityColors[e.canonical] ?? "#666" }} />
                  <Link to={`/thread?entity=${encodeURIComponent(e.canonical)}`} className="coherence-name" title={e.display ? `Original: ${e.canonical}` : undefined}>
                    {label}
                  </Link>
                  <span className="muted small mono">{e.session_count}</span>
                  <div className="coherence-actions" role="group" aria-label="Move to bucket">
                    {(["active", "sparse", "stale"] as const).map((b) => (
                      <button
                        key={b}
                        type="button"
                        className={`chip${e.coherence === b ? " active" : ""}`}
                        data-severity={b === "active" ? undefined : b === "sparse" ? "medium" : "high"}
                        disabled={rowBusy || e.coherence === b}
                        onClick={() => void setBucket(e.canonical, b)}
                      >{b}</button>
                    ))}
                    {overridden && (
                      <button
                        type="button"
                        className="chip"
                        disabled={rowBusy}
                        onClick={() => void setBucket(e.canonical, null)}
                        title={`Natural bucket is ${e.coherence_computed}. Click to revert.`}
                      >revert</button>
                    )}
                  </div>
                </li>
              );
            })}
            {rows.length === 0 && (
              <li className="muted empty-row">No topics in this bucket right now.</li>
            )}
          </ul>
        </div>
      </aside>
    </>
  );
}
