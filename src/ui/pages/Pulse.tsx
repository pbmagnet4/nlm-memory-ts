import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDataset, relativeAge } from "../lib/dataset.js";
import { postAction } from "../lib/actions.js";

export function PulsePage() {
  const { data, loading, error, refetch } = useDataset();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (alertId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(alertId)) next.delete(alertId);
      else next.add(alertId);
      return next;
    });
  };

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
          <div className="bar-stack">
            <Bar tone="active" label="Healthy" value={data.metrics.healthy} />
            <Bar tone="warn" label="Sparse" value={data.metrics.sparse} />
            <Bar tone="danger" label="Stale" value={data.metrics.stale} />
          </div>
        </section>

        <section className="card pulse-scroll-card">
          <header className="card-head"><h3>Stale alerts</h3><span className="muted small">{data.alerts.length}</span></header>
          <div className="pulse-scroll-body">
            <ul className="alert-list">
              {data.alerts.map((a) => {
                const isExpanded = expanded.has(a.id);
                return (
                  <li key={a.id} className="alert-row">
                    <span className={`chip-inline severity-${a.severity}`}>{a.severity}</span>
                    <Link to={`/thread?entity=${encodeURIComponent(a.entity)}`} className="alert-entity">{a.entity}</Link>
                    <button
                      type="button"
                      className={`alert-summary${isExpanded ? " is-expanded" : ""}`}
                      onClick={() => toggleExpand(a.id)}
                      title={isExpanded ? "Click to collapse" : a.summary}
                    >
                      {a.summary}
                    </button>
                    <div className="alert-actions">
                      <button type="button" className="chip" onClick={() => void snoozeAlert(a.id, 7)}>snooze 7d</button>
                      <button type="button" className="chip" onClick={() => void dismissAlert(a.id)}>dismiss</button>
                    </div>
                  </li>
                );
              })}
              {data.alerts.length === 0 && <li className="muted alert-row-empty">No stale alerts.</li>}
            </ul>
          </div>
        </section>

        <section className="card pulse-recent pulse-scroll-card">
          <header className="card-head"><h3>Recent sessions</h3></header>
          <div className="pulse-scroll-body">
            <ul className="session-list">
              {recent.map((s) => (
                <li key={s.id} className="session-row">
                  <span className={`chip-inline status-${s.status}`}>{s.status}</span>
                  <span className="session-label">{s.label}</span>
                  <span className="session-meta">{relativeAge(s.started_at)} · {s.entities.slice(0, 3).join(", ")}{s.entities.length > 3 ? ` +${s.entities.length - 3}` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
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

function Bar({ tone, label, value }: { tone: "active" | "warn" | "danger"; label: string; value: number }) {
  return (
    <div className="bar-item">
      <span className="bar-label">{label}</span>
      <div className="bar-track"><div className={`bar-fill tone-${tone}`} style={{ width: `${Math.min(100, value)}px` }} /></div>
      <span className="bar-value mono">{value}</span>
    </div>
  );
}
