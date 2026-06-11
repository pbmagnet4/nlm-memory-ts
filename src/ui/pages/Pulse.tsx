import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useDataset, relativeAge } from "../lib/dataset.js";
import { fmt } from "../lib/format.js";
import type { DatasetAlert, DatasetEntity, DatasetRuntime, DatasetSession, TopicCoherence } from "../lib/dataset.js";
import { postAction } from "../lib/actions.js";
import { SessionDrawer } from "../components/SessionDrawer.js";
import { PromoteOpenButton } from "../components/PromoteOpenButton.js";
import { PulseSkeleton } from "../components/Skeleton.js";
import { Drawer } from "../components/Drawer.js";
import { Pagination } from "../components/Pagination.js";
import { FilterGroup, FilterChip } from "../components/FilterGroup.js";
import { rowProps } from "../lib/rowProps.js";
import { toast } from "../lib/toast.js";

type SeverityFilter = "all" | "high" | "medium" | "low";
type AlertSort = "oldest" | "recent";
type CountFilter = "any" | "1" | "2-5" | "6+";
type CoherenceSort = "most" | "fewest" | "recent" | "oldest";

export function PulsePage() {
  const { data, loading, error, refetch } = useDataset();
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [sort, setSort] = useState<AlertSort>("oldest");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [coherenceBucket, setCoherenceBucket] = useState<TopicCoherence | null>(null);
  const [runtimeName, setRuntimeName] = useState<string | null>(null);

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
    try {
      await postAction({ kind: "dismiss", subject_type: "alert", subject_id: alertId });
      toast.success("Alert dismissed");
      await refetch();
    } catch (e) {
      toast.error(`Failed to dismiss: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const snoozeAlert = async (alertId: string, days: number) => {
    const until = new Date(Date.now() + days * 86_400_000).toISOString();
    try {
      await postAction({
        kind: "snooze",
        subject_type: "alert",
        subject_id: alertId,
        payload: { snoozed_until: until },
      });
      toast.success(`Snoozed for ${fmt.plural(days, "day")}`);
      await refetch();
    } catch (e) {
      toast.error(`Failed to snooze: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const recent = useMemo(() => {
    if (!data) return [];
    return data.sessions
      .filter((s) => s.status !== "replaced")
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
        <Kpi label="This week" value={data.metrics.this_week} hint={`${data.metrics.last_week} last week`} to="/river" />
        <Kpi label="Sessions" value={data.meta.sessions_total} hint="total" to="/river" />
        <Kpi label="Topics" value={data.meta.entities_total} hint="catalogued" to="/thread" />
        <Kpi label="Decisions" value={data.metrics.closed_decisions} hint="non-superseded" to="/recall" />
        <KpiSparkline values={data.metrics.sparkline} to="/river" />
      </div>

      <div className="pulse-grid">
        <section className="card pulse-scroll-card pulse-area-coherence">
          <header className="card-head"><h3>Topic Coherence</h3></header>
          <div className="pulse-scroll-body">
            <CoherenceBars
              metrics={data.metrics}
              onPick={(bucket) => setCoherenceBucket(bucket)}
            />
          </div>
        </section>

        <section className="card pulse-scroll-card pulse-area-runtimes">
          <header className="card-head"><h3>Runtimes</h3></header>
          <div className="pulse-scroll-body">
            <RuntimesPanel runtimes={data.runtimes} onPick={setRuntimeName} />
          </div>
        </section>

        <section className="card pulse-scroll-card pulse-area-recent">
          <header className="card-head">
            <h3>Recent sessions</h3>
            {recentSpan && <span className="muted small">{recentSpan}</span>}
          </header>
          <div className="pulse-scroll-body">
            <ul className="session-list">
              {recent.map((s) => (
                <li key={s.id} className="session-row clickable" {...rowProps(() => setSessionId(s.id))}>
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
              <FilterGroup label="Severity">
                {(["all", "high", "medium", "low"] as const).map((s) => (
                  <FilterChip
                    key={s}
                    active={severity === s}
                    count={severityCounts[s]}
                    onClick={() => setSeverity(s)}
                    data-severity={s === "all" ? undefined : s}
                  >{s}</FilterChip>
                ))}
              </FilterGroup>
              <FilterGroup label="Sort">
                <FilterChip active={sort === "oldest"} onClick={() => setSort("oldest")}>oldest</FilterChip>
                <FilterChip active={sort === "recent"} onClick={() => setSort("recent")}>recent</FilterChip>
              </FilterGroup>
            </div>
          </header>
          <div className="pulse-scroll-body">
            <ul className="alert-list">
              {filteredAlerts.map((a) => (
                <li key={a.id} className="alert-row clickable" {...rowProps(() => setDetailId(a.id))}>
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
                <li className="muted empty-row">
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

      {runtimeName && (
        <RuntimeDrawer
          runtimeName={runtimeName}
          runtime={data.runtimes.find((r) => r.name === runtimeName) ?? null}
          sessions={data.sessions}
          entities={data.entities}
          entityColors={data.entity_colors}
          entityDisplay={data.entity_display}
          onClose={() => setRuntimeName(null)}
          onSession={setSessionId}
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

  const currentPage = Math.min(page, Math.max(0, Math.ceil(related.length / pageSize) - 1));
  const sessionSlice = related.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  const openQuestions = useMemo(
    () => related.flatMap((s) => s.open_questions.map((q) => ({ id: q.id, text: q.text, sid: s.id, when: s.started_at }))),
    [related],
  );

  const decisions = useMemo(
    () => related.flatMap((s) => s.decisions.map((d) => ({ text: d, sid: s.id, when: s.started_at }))),
    [related],
  );

  return (
    <Drawer
      onClose={onClose}
      ariaLabel={`Alert detail: ${entity?.display ?? alert.entity}`}
      head={
        <>
          <span className="dot lg" style={{ background: entityColor }} />
          <h3 className="drawer-title" title={entity?.display ? `Original: ${alert.entity}` : undefined}>{entity?.display ?? alert.entity}</h3>
          <span className={`chip-inline severity-${alert.severity}`}>{alert.severity}</span>
        </>
      }
      footer={
        <Pagination
          page={currentPage}
          pageSize={pageSize}
          total={related.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      }
    >
          <p className="drawer-paragraph">{alert.summary}</p>

          <dl className="kv-list">
            <dt className="kv-label">Last touch</dt>
            <dd className="kv-value">{fmt.plural(alert.age_days, "day")} ago</dd>
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
    </Drawer>
  );
}

function Kpi({ label, value, hint, to }: { label: string; value: number; hint?: string; to?: string }) {
  const inner = (
    <>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{fmt.count(value)}</span>
      {hint && <span className="kpi-hint">{hint}</span>}
    </>
  );
  if (to) return <Link to={to} className="kpi kpi-clickable">{inner}</Link>;
  return <div className="kpi">{inner}</div>;
}

function KpiSparkline({ values, to }: { values: number[]; to?: string }) {
  const max = Math.max(1, ...values);
  const inner = (
    <>
      <span className="kpi-label">Last 7 days</span>
      <div className="sparkline">
        {values.map((v, i) => (
          <span key={i} className="spark-bar" style={{ height: `${(v / max) * 100}%` }} title={`${v} sessions`} />
        ))}
      </div>
    </>
  );
  if (to) return <Link to={to} className="kpi kpi-sparkline kpi-clickable">{inner}</Link>;
  return <div className="kpi kpi-sparkline">{inner}</div>;
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

function RuntimesPanel({ runtimes, onPick }: { runtimes: DatasetRuntime[]; onPick: (name: string) => void }) {
  if (runtimes.length === 0) {
    return <div className="muted empty-row">No runtime activity yet.</div>;
  }
  return (
    <ul className="runtime-list">
      {runtimes.map((r) => (
        <li key={r.name} className="runtime-row clickable" {...rowProps(() => onPick(r.name))}>
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
      title={`${fmt.plural(value, "topic")} · ${rounded}% of total${interactive ? " · click to review" : ""}`}
    >
      <span className="bar-label">{label}</span>
      <div className="bar-track">
        <div className={`bar-fill tone-${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="bar-value mono">{fmt.count(value)}<span className="bar-pct muted small"> · {rounded}%</span></span>
    </button>
  );
}

function MergePicker({
  source,
  entities,
  entityColors,
  entityDisplay,
  onMerge,
  onCancel,
}: {
  source: string;
  entities: DatasetEntity[];
  entityColors: Record<string, string>;
  entityDisplay: Record<string, string>;
  onMerge: (into: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const sourceLabel = entityDisplay[source] ?? source;

  const candidates = useMemo(() => {
    const q = query.toLowerCase();
    return entities
      .filter(
        (e) =>
          e.canonical !== source &&
          e.status !== "retired" &&
          (q === "" || (entityDisplay[e.canonical] ?? e.canonical).toLowerCase().includes(q)),
      )
      .sort((a, b) => b.session_count - a.session_count)
      .slice(0, 8);
  }, [entities, source, entityDisplay, query]);

  const handleKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      onCancel();
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, candidates.length - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (confirming) {
        if (selected) onMerge(selected);
      } else if (candidates[activeIndex]) {
        setSelected(candidates[activeIndex].canonical);
        setConfirming(true);
      }
    }
  };

  if (confirming && selected) {
    const selectedLabel = entityDisplay[selected] ?? selected;
    return (
      <div
        className="merge-picker"
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-label={`Confirm merge ${sourceLabel}`}
        aria-modal="false"
      >
        <p className="drawer-paragraph">
          Merge <strong>{sourceLabel}</strong> into <strong>{selectedLabel}</strong>?
        </p>
        <p className="drawer-paragraph muted small">
          Sessions tagged to "{sourceLabel}" will be attributed to "{selectedLabel}" going forward.
        </p>
        <div className="filter-group">
          <button type="button" className="chip" onClick={() => setConfirming(false)}>Cancel</button>
          <button type="button" className="chip active" onClick={() => onMerge(selected)}>Confirm merge</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="merge-picker"
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-label={`Merge ${sourceLabel} into another topic`}
      aria-modal="false"
    >
      <p className="drawer-paragraph merge-picker-paragraph">
        Merge <strong>{sourceLabel}</strong> into:
      </p>
      <input
        ref={inputRef}
        className="form-input"
        type="text"
        placeholder="Type to search topics…"
        value={query}
        onChange={(ev) => { setQuery(ev.currentTarget.value); setActiveIndex(0); }}
        aria-label="Search topics"
        aria-autocomplete="list"
      />
      <ul className="merge-result-list">
        {candidates.map((e, i) => {
          const label = entityDisplay[e.canonical] ?? e.canonical;
          return (
            <li
              key={e.canonical}
              className={`merge-result-row${i === activeIndex ? " is-selected" : ""}`}
              onClick={() => { setSelected(e.canonical); setActiveIndex(i); setConfirming(true); }}
            >
              <span className="dot" style={{ background: entityColors[e.canonical] ?? "#666" }} />
              <span className="session-label">{label}</span>
              <span className="session-meta">{fmt.plural(e.session_count, "session")} · {e.coherence}</span>
            </li>
          );
        })}
        {candidates.length === 0 && (
          <li className="muted empty-row">No topics match.</li>
        )}
      </ul>
      <div className="filter-group merge-picker-filter-group">
        <button type="button" className="chip" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="chip active"
          disabled={!candidates[activeIndex]}
          onClick={() => { setSelected(candidates[activeIndex].canonical); setConfirming(true); }}
        >
          Merge into selected →
        </button>
      </div>
    </div>
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
  const [mergeSource, setMergeSource] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<number>(10);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [countFilter, setCountFilter] = useState<CountFilter>("any");
  const [sort, setSort] = useState<CoherenceSort>("most");
  const [overriddenOnly, setOverriddenOnly] = useState(false);

  // All rows for this bucket — used for filter-chip counts.
  const allRows = useMemo(
    () => entities.filter((e) => e.coherence === bucket && e.session_count > 0),
    [entities, bucket],
  );

  const countCounts = useMemo(() => ({
    any: allRows.length,
    "1": allRows.filter((e) => e.session_count === 1).length,
    "2-5": allRows.filter((e) => e.session_count >= 2 && e.session_count <= 5).length,
    "6+": allRows.filter((e) => e.session_count >= 6).length,
  }), [allRows]);

  const overriddenCount = useMemo(
    () => allRows.filter((e) => e.coherence !== e.coherence_computed).length,
    [allRows],
  );

  const rows = useMemo(() => {
    let filtered = allRows;
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter((e) => (entityDisplay[e.canonical] ?? e.canonical).toLowerCase().includes(q));
    }
    if (countFilter === "1") filtered = filtered.filter((e) => e.session_count === 1);
    else if (countFilter === "2-5") filtered = filtered.filter((e) => e.session_count >= 2 && e.session_count <= 5);
    else if (countFilter === "6+") filtered = filtered.filter((e) => e.session_count >= 6);
    if (overriddenOnly) filtered = filtered.filter((e) => e.coherence !== e.coherence_computed);
    return [...filtered].sort((a, b) => {
      if (sort === "most") return b.session_count - a.session_count;
      if (sort === "fewest") return a.session_count - b.session_count;
      if (sort === "recent") return (b.last_seen_session ?? "").localeCompare(a.last_seen_session ?? "");
      return (a.last_seen_session ?? "").localeCompare(b.last_seen_session ?? "");
    });
  }, [allRows, query, countFilter, sort, overriddenOnly, entityDisplay]);

  const filtersActive = query !== "" || countFilter !== "any" || overriddenOnly;

  useEffect(() => { setPage(0); }, [bucket, pageSize, query, countFilter, sort, overriddenOnly]);

  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  const slice = rows.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  const postMerge = async (into: string) => {
    if (!mergeSource) return;
    const source = mergeSource;
    const sourceLabel = entityDisplay[source] ?? source;
    const intoLabel = entityDisplay[into] ?? into;
    setBusy(source);
    setMergeSource(null);
    try {
      await postAction({
        kind: "merge_entity",
        subject_type: "entity",
        subject_id: source,
        payload: { into },
      });
      toast.success(`Merged "${sourceLabel}" into "${intoLabel}"`);
      await onChanged();
    } catch (e) {
      toast.error(`Merge failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

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
    } catch (e) {
      toast.error(`Failed to update coherence: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer
      onClose={onClose}
      ariaLabel={`${COHERENCE_TITLE[bucket]} review`}
      className="coherence-drawer"
      blockEsc={mergeSource !== null}
      head={
        <>
          <h3 className="drawer-title">{COHERENCE_TITLE[bucket]}</h3>
          <span className={`chip-inline${bucket === "active" ? "" : ` severity-${bucket === "sparse" ? "medium" : "high"}`}`}>{fmt.count(rows.length)}</span>
        </>
      }
      footer={
        <Pagination
          page={currentPage}
          pageSize={pageSize}
          total={rows.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      }
    >
          <p className="drawer-paragraph drawer-hint">{COHERENCE_HINT[bucket]}</p>
          <div className={`coherence-filters${mergeSource ? " coherence-rows-dimmed" : ""}`}>
            <input
              className="form-input coherence-search"
              type="text"
              placeholder="Search topics…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              aria-label="Search topics"
            />
            <div className="coherence-filter-row">
              <select
                className="form-input form-input-inline"
                value={countFilter}
                onChange={(e) => setCountFilter(e.currentTarget.value as CountFilter)}
                aria-label="Session count"
              >
                <option value="any">any · {countCounts["any"]}</option>
                <option value="1">1 session · {countCounts["1"]}</option>
                <option value="2-5">2–5 sessions · {countCounts["2-5"]}</option>
                <option value="6+">6+ sessions · {countCounts["6+"]}</option>
              </select>
              <FilterGroup label="Sort">
                {(["most", "fewest", "recent", "oldest"] as const).map((s) => (
                  <FilterChip key={s} active={sort === s} onClick={() => setSort(s)}>{s}</FilterChip>
                ))}
              </FilterGroup>
              {overriddenCount > 0 && (
                <FilterChip active={overriddenOnly} count={overriddenCount} onClick={() => setOverriddenOnly((v) => !v)}>
                  overridden
                </FilterChip>
              )}
            </div>
          </div>
          {mergeSource && (
            <MergePicker
              source={mergeSource}
              entities={entities}
              entityColors={entityColors}
              entityDisplay={entityDisplay}
              onMerge={(into) => void postMerge(into)}
              onCancel={() => setMergeSource(null)}
            />
          )}
          <ul className={`session-list coherence-session-list${mergeSource ? " coherence-rows-dimmed" : ""}`}>
            {slice.map((e) => {
              const label = entityDisplay[e.canonical] ?? e.canonical;
              const overridden = e.coherence !== e.coherence_computed;
              const rowBusy = busy === e.canonical;
              return (
                <li key={e.canonical} className="session-row" aria-busy={rowBusy || undefined}>
                  <span className="dot" style={{ background: entityColors[e.canonical] ?? "#666" }} />
                  <Link
                    to={`/thread?entity=${encodeURIComponent(e.canonical)}`}
                    className="session-label"
                    title={e.display ? `Original: ${e.canonical}` : undefined}
                  >{label}</Link>
                  <span className="session-meta coherence-meta">{fmt.plural(e.session_count, "session")}{overridden ? ` · naturally ${e.coherence_computed}` : ""}</span>
                  <div className="filter-group" role="group" aria-label="Move to bucket">
                    {(["active", "sparse", "stale"] as const).map((b) => (
                      <button
                        key={b}
                        type="button"
                        className={`chip${e.coherence === b ? " active" : ""}`}
                        data-bucket={b}
                        disabled={rowBusy || e.coherence === b}
                        onClick={() => void setBucket(e.canonical, b)}
                      >{b}</button>
                    ))}
                    {bucket === "sparse" && (
                      <button
                        type="button"
                        className={`chip${mergeSource === e.canonical ? " active" : ""}`}
                        disabled={rowBusy}
                        onClick={() => setMergeSource(mergeSource === e.canonical ? null : e.canonical)}
                        title="Merge this topic into another"
                      >merge</button>
                    )}
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
              <li className="muted empty-row">
                {filtersActive ? "No topics match the current filters." : "No topics in this bucket right now."}
              </li>
            )}
          </ul>
    </Drawer>
  );
}

function RuntimeDrawer({
  runtimeName,
  runtime,
  sessions,
  entities,
  entityColors,
  entityDisplay,
  onClose,
  onSession,
}: {
  runtimeName: string;
  runtime: DatasetRuntime | null;
  sessions: DatasetSession[];
  entities: DatasetEntity[];
  entityColors: Record<string, string>;
  entityDisplay: Record<string, string>;
  onClose: () => void;
  onSession: (id: string) => void;
}) {
  const [pageSize, setPageSize] = useState<number>(10);
  const [page, setPage] = useState(0);

  const runtimeSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.runtime === runtimeName)
        .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? "")),
    [sessions, runtimeName],
  );

  const runtimeTopics = useMemo(() => {
    const seen = new Set<string>();
    for (const s of runtimeSessions) for (const e of s.entities) seen.add(e);
    return entities
      .filter((e) => seen.has(e.canonical))
      .sort((a, b) => b.session_count - a.session_count);
  }, [runtimeSessions, entities]);

  useEffect(() => { setPage(0); }, [runtimeName, pageSize]);

  const currentPage = Math.min(page, Math.max(0, Math.ceil(runtimeSessions.length / pageSize) - 1));
  const sessionSlice = runtimeSessions.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  const statusColor = runtime?.status === "active" ? "var(--tone-active)" : runtime?.status === "idle" ? "var(--tone-warn)" : "var(--muted)";

  return (
    <Drawer
      onClose={onClose}
      ariaLabel={`Runtime: ${runtimeName}`}
      head={
        <>
          <span className="dot lg" style={{ background: statusColor }} />
          <h3 className="drawer-title">{runtimeName}</h3>
          {runtime && <span className={`chip-inline status-${runtime.status}`}>{runtime.status}</span>}
        </>
      }
      footer={
        <Pagination
          page={currentPage}
          pageSize={pageSize}
          total={runtimeSessions.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      }
    >
          {runtime && (
            <dl className="kv-list">
              <dt className="kv-label">This week</dt>
              <dd className="kv-value mono">{runtime.this_week}</dd>
              <dt className="kv-label">Last week</dt>
              <dd className="kv-value mono">{runtime.last_week}</dd>
              <dt className="kv-label">Total sessions</dt>
              <dd className="kv-value mono">{runtime.sessions_total}</dd>
              <dt className="kv-label">Last session</dt>
              <dd className="kv-value mono small">{relativeAge(runtime.last_session_at)}</dd>
            </dl>
          )}

          {runtimeTopics.length > 0 && (
            <>
              <h4 className="drawer-section">Topics ({runtimeTopics.length})</h4>
              <div className="runtime-topics">
                {runtimeTopics.slice(0, 20).map((e) => (
                  <span
                    key={e.canonical}
                    className="chip-inline"
                    style={{ borderColor: entityColors[e.canonical] ?? undefined }}
                    title={`${fmt.plural(e.session_count, "session")} · ${e.coherence}`}
                  >
                    {entityDisplay[e.canonical] ?? e.canonical}
                  </span>
                ))}
                {runtimeTopics.length > 20 && <span className="muted small">+{runtimeTopics.length - 20} more</span>}
              </div>
            </>
          )}

          <h4 className="drawer-section">Sessions ({runtimeSessions.length})</h4>
          <ul className="session-list">
            {sessionSlice.map((s) => (
              <li key={s.id} className="session-row clickable" {...rowProps(() => onSession(s.id))}>
                <span className={`chip-inline status-${s.status}`}>{s.status}</span>
                <span className="session-label">{s.label}</span>
                <span className="session-meta muted small mono">{relativeAge(s.started_at)}</span>
              </li>
            ))}
            {runtimeSessions.length === 0 && <li className="muted empty-row">No sessions found.</li>}
          </ul>
    </Drawer>
  );
}
