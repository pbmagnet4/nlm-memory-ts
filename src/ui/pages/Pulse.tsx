import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useDataset, relativeAge } from "../lib/dataset.js";
import type { DatasetAlert, DatasetEntity, DatasetSession } from "../lib/dataset.js";
import { postAction } from "../lib/actions.js";
import { SessionDrawer } from "../components/SessionDrawer.js";
import { PromoteOpenButton } from "../components/PromoteOpenButton.js";

type SeverityFilter = "all" | "high" | "medium";
type AlertSort = "oldest" | "recent";

export function PulsePage() {
  const { data, loading, error, refetch } = useDataset();
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [sort, setSort] = useState<AlertSort>("oldest");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const filteredAlerts = useMemo(() => {
    if (!data) return [];
    const filtered = severity === "all" ? data.alerts : data.alerts.filter((a) => a.severity === severity);
    return [...filtered].sort((a, b) => (sort === "oldest" ? b.age_days - a.age_days : a.age_days - b.age_days));
  }, [data, severity, sort]);

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

  if (loading && !data) return <div className="page-pad"><div className="muted">Loading dataset…</div></div>;
  if (error && !data) return <div className="page-pad"><div className="muted error">{error}</div></div>;
  if (!data) return null;

  const detailAlert = detailId ? data.alerts.find((a) => a.id === detailId) ?? null : null;

  return (
    <div className="page-pad">
      <div className="kpi-row">
        <Kpi label="This week" value={data.metrics.this_week} hint={`${data.metrics.last_week} last week`} />
        <Kpi label="Sessions" value={data.meta.sessions_total} hint="total" />
        <Kpi label="Entities" value={data.meta.entities_total} hint="catalogued" />
        <Kpi label="Decisions" value={data.metrics.closed_decisions} hint="non-superseded" />
        <KpiSparkline values={data.metrics.sparkline} />
      </div>

      <div className="pulse-grid">
        <section className="card">
          <header className="card-head"><h3>Coherence</h3></header>
          <CoherenceBars metrics={data.metrics} />
        </section>

        <section className="card pulse-scroll-card">
          <header className="card-head card-head-stack">
            <div className="card-head-row">
              <h3>Stale alerts</h3>
              <span className="muted small">
                {filteredAlerts.length}{filteredAlerts.length !== data.alerts.length ? ` / ${data.alerts.length}` : ""}
              </span>
            </div>
            <div className="card-filters">
              <div className="filter-group" role="group" aria-label="Severity">
                {(["all", "high", "medium"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`chip${severity === s ? " active" : ""}`}
                    data-severity={s === "all" ? undefined : s}
                    onClick={() => setSeverity(s)}
                  >{s}</button>
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
                  <span className="alert-entity">{a.entity}</span>
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

        <section className="card pulse-recent pulse-scroll-card">
          <header className="card-head"><h3>Recent sessions</h3></header>
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
                  <span className="session-meta">{relativeAge(s.started_at)} · {s.entities.slice(0, 3).join(", ")}{s.entities.length > 3 ? ` +${s.entities.length - 3}` : ""}</span>
                </li>
              ))}
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
      <aside className="session-drawer" role="dialog" aria-modal="true" aria-label={`Alert detail: ${alert.entity}`}>
        <header className="drawer-head">
          <span className="dot lg" style={{ background: entityColor }} />
          <h3 className="drawer-title">{alert.entity}</h3>
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
                <dt className="kv-label">Entity type</dt>
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

function CoherenceBars({ metrics }: { metrics: { healthy: number; sparse: number; stale: number } }) {
  const total = metrics.healthy + metrics.sparse + metrics.stale;
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  return (
    <div className="bar-stack">
      <Bar tone="active" label="Healthy" value={metrics.healthy} pct={pct(metrics.healthy)} />
      <Bar tone="warn"   label="Sparse"  value={metrics.sparse}  pct={pct(metrics.sparse)} />
      <Bar tone="danger" label="Stale"   value={metrics.stale}   pct={pct(metrics.stale)} />
    </div>
  );
}

function Bar({ tone, label, value, pct }: {
  tone: "active" | "warn" | "danger";
  label: string;
  value: number;
  pct: number;
}) {
  const rounded = Math.round(pct);
  return (
    <div className="bar-item">
      <span className="bar-label">{label}</span>
      <div className="bar-track" title={`${value.toLocaleString()} entit${value === 1 ? "y" : "ies"} · ${rounded}% of total`}>
        <div className={`bar-fill tone-${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="bar-value mono">{value.toLocaleString()}<span className="bar-pct muted small"> · {rounded}%</span></span>
    </div>
  );
}
