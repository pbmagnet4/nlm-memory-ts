import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDataset, relativeAge } from "../lib/dataset.js";
import type { DatasetSession } from "../lib/dataset.js";
import { SessionDrawer } from "../components/SessionDrawer.js";
import { PromoteOpenButton } from "../components/PromoteOpenButton.js";
import { SessionListSkeleton, Skeleton } from "../components/Skeleton.js";

export function ThreadPage() {
  const { data, loading, error, refetch } = useDataset();
  const [params, setParams] = useSearchParams();
  const entity = params.get("entity") ?? "";
  const drawerSid = params.get("session");

  const [sort, setSort] = useState<"recent" | "oldest">(() => {
    try {
      const raw = window.localStorage.getItem("nle.settings.views");
      if (raw) return (JSON.parse(raw) as { threadSort?: "recent" | "oldest" }).threadSort ?? "recent";
    } catch { /* ignore */ }
    return "recent";
  });

  const thread = useMemo(() => {
    if (!data || !entity) return [];
    const sessions = data.sessions.filter((s) => s.entities.includes(entity));
    sessions.sort((a, b) => {
      const av = a.started_at ?? "";
      const bv = b.started_at ?? "";
      return sort === "recent" ? bv.localeCompare(av) : av.localeCompare(bv);
    });
    return sessions;
  }, [data, entity, sort]);

  const entityColor = entity && data ? (data.entity_colors[entity] ?? "#666") : "#666";

  useEffect(() => {
    if (entity && data) document.title = `${entity} — Thread`;
  }, [entity, data]);

  const openSession = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("session", id);
    setParams(next);
  };

  const closeSession = () => {
    const next = new URLSearchParams(params);
    next.delete("session");
    setParams(next);
  };

  if (loading && !data) return (
    <div className="page-pad">
      <Skeleton h={22} w={220} />
      <div style={{ marginTop: 16 }}><SessionListSkeleton rows={8} /></div>
    </div>
  );
  if (error && !data) return <div className="page-pad"><div className="muted error">{error}</div></div>;
  if (!data) return null;

  if (!entity) {
    return (
      <div className="page-pad">
        <h2 className="page-title">Thread</h2>
        <p className="muted">Pick an entity to view its reasoning history.</p>
        <ul className="entity-grid">
          {data.entities.slice(0, 48).map((e) => (
            <li key={e.canonical}>
              <Link to={`/thread?entity=${encodeURIComponent(e.canonical)}`} className="card card-lift entity-card">
                <span className="dot" style={{ background: data.entity_colors[e.canonical] ?? "#666" }} />
                <span className="entity-name">{e.canonical}</span>
                <span className="muted small">{e.session_count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const decisions = thread.flatMap((s) => s.decisions.map((d) => ({ d, sid: s.id, when: s.started_at })));
  const open = thread.flatMap((s) =>
    s.open_questions.map((q) => ({ id: q.id, q: q.text, sid: s.id, when: s.started_at })),
  );

  return (
    <div className="page-pad">
      <div className="thread-header">
        <span className="dot lg" style={{ background: entityColor }} />
        <h2 className="page-title">{entity}</h2>
        <span className="muted">{thread.length} session{thread.length === 1 ? "" : "s"}</span>
        <span className="header-spacer" />
        <select className="form-input" value={sort} onChange={(e) => setSort(e.target.value as "recent" | "oldest")}>
          <option value="recent">Most recent first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      <div className="thread-grid">
        <section className="card">
          <header className="card-head"><h3>Decisions</h3><span className="muted small">{decisions.length}</span></header>
          <ul className="marker-list">
            {decisions.slice(0, 30).map((d, i) => (
              <li key={i} className="marker-row">
                <span className="live-tag" data-kind="decision">decision</span>
                <span className="marker-text">{d.d}</span>
                <button type="button" className="link-button" onClick={() => openSession(d.sid)}>{relativeAge(d.when)}</button>
              </li>
            ))}
            {decisions.length === 0 && <li className="muted small">No decisions captured.</li>}
          </ul>
        </section>

        <section className="card">
          <header className="card-head"><h3>Open questions</h3><span className="muted small">{open.length}</span></header>
          <ul className="marker-list">
            {open.slice(0, 30).map((o, i) => (
              <li key={`${o.id}-${i}`} className="marker-row marker-row-promotable">
                <span className="live-tag" data-kind="open">open</span>
                <span className="marker-text">{o.q}</span>
                <div className="marker-actions">
                  <PromoteOpenButton openId={o.id} defaultText={o.q} onPromoted={refetch} />
                  <button type="button" className="link-button" onClick={() => openSession(o.sid)}>{relativeAge(o.when)}</button>
                </div>
              </li>
            ))}
            {open.length === 0 && <li className="muted small">No open questions.</li>}
          </ul>
        </section>
      </div>

      <ThreadSessionList thread={thread} onOpenSession={openSession} />

      {drawerSid && (
        <SessionDrawer sessionId={drawerSid} onClose={closeSession} entityColor={entityColor} />
      )}
    </div>
  );
}

type StatusFilter = "all" | "active" | "idle" | "closed" | "superseded";
type MarkerFilter = "all" | "decisions" | "open";
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

function ThreadSessionList({
  thread,
  onOpenSession,
}: {
  thread: DatasetSession[];
  onOpenSession: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [markers, setMarkers] = useState<MarkerFilter>("all");
  const [pageSize, setPageSize] = useState<number>(25);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return thread.filter((s) => {
      if (status !== "all" && s.status !== status) return false;
      if (markers === "decisions" && s.decisions.length === 0) return false;
      if (markers === "open" && s.open_questions.length === 0) return false;
      if (!q) return true;
      return (
        s.label.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q) ||
        s.decisions.some((d) => d.toLowerCase().includes(q)) ||
        s.open.some((o) => o.toLowerCase().includes(q))
      );
    });
  }, [thread, query, status, markers]);

  // Reset page when filter inputs change
  useEffect(() => { setPage(0); }, [query, status, markers, pageSize]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  return (
    <>
      <div className="thread-sessions-head">
        <h3 className="section-title thread-sessions-title">Sessions</h3>
        <input
          className="search-input"
          placeholder="search label, summary, decisions, open…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="thread-filters">
        <div className="filter-group" role="group" aria-label="Status filter">
          {(["all", "active", "idle", "closed", "superseded"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`chip${status === s ? " active" : ""}`}
              data-status={s === "all" ? undefined : s}
              onClick={() => setStatus(s)}
            >{s}</button>
          ))}
        </div>
        <div className="filter-group" role="group" aria-label="Marker filter">
          {(["all", "decisions", "open"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`chip${markers === m ? " active" : ""}`}
              data-marker={m === "all" ? undefined : m}
              onClick={() => setMarkers(m)}
            >{m === "all" ? "all markers" : m}</button>
          ))}
        </div>
        <span className="header-spacer" />
        <span className="muted small">{filtered.length} match{filtered.length === 1 ? "" : "es"}</span>
      </div>

      <ul className="session-list">
        {slice.map((s) => (
          <li key={s.id} className="session-row session-row-detail clickable" onClick={() => onOpenSession(s.id)}>
            <span className={`chip-inline status-${s.status}`}>{s.status}</span>
            <div className="session-row-main">
              <span className="session-label">{s.label}</span>
              <span className="session-meta">{s.summary}</span>
            </div>
            <span className="muted small mono">{relativeAge(s.started_at)}</span>
          </li>
        ))}
        {slice.length === 0 && (
          <li className="muted small empty-row">
            {thread.length === 0 ? "No sessions yet." : "No sessions match the current filters."}
          </li>
        )}
      </ul>

      {filtered.length > 0 && (
        <div className="pagination">
          <div className="page-size">
            <label className="form-label">Per page</label>
            <select
              className="form-input form-input-inline"
              value={pageSize}
              onChange={(e) => setPageSize(Number.parseInt(e.target.value, 10))}
            >
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <span className="header-spacer" />
          <span className="muted small">
            {start + 1}–{Math.min(start + pageSize, filtered.length)} of {filtered.length}
          </span>
          <div className="page-nav">
            <button type="button" className="chip" disabled={currentPage === 0} onClick={() => setPage(0)}>« first</button>
            <button type="button" className="chip" disabled={currentPage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ prev</button>
            <span className="page-indicator mono">{currentPage + 1} / {pageCount}</span>
            <button type="button" className="chip" disabled={currentPage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>next ›</button>
            <button type="button" className="chip" disabled={currentPage >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>last »</button>
          </div>
        </div>
      )}
    </>
  );
}

