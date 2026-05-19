import { useMemo, useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDataset, relativeAge } from "../lib/dataset.js";

export function ThreadPage() {
  const { data, loading, error } = useDataset();
  const [params] = useSearchParams();
  const entity = params.get("entity") ?? "";

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

  if (loading && !data) return <div className="page-pad"><div className="muted">Loading dataset…</div></div>;
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
  const open = thread.flatMap((s) => s.open_questions.map((q) => ({ q: q.text, sid: s.id, when: s.started_at })));

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
                <span className="muted small">{relativeAge(d.when)}</span>
              </li>
            ))}
            {decisions.length === 0 && <li className="muted small">No decisions captured.</li>}
          </ul>
        </section>

        <section className="card">
          <header className="card-head"><h3>Open questions</h3><span className="muted small">{open.length}</span></header>
          <ul className="marker-list">
            {open.slice(0, 30).map((o, i) => (
              <li key={i} className="marker-row">
                <span className="live-tag" data-kind="open">open</span>
                <span className="marker-text">{o.q}</span>
                <span className="muted small">{relativeAge(o.when)}</span>
              </li>
            ))}
            {open.length === 0 && <li className="muted small">No open questions.</li>}
          </ul>
        </section>
      </div>

      <h3 className="section-title">Sessions</h3>
      <ul className="session-list">
        {thread.map((s) => (
          <li key={s.id} className="session-row session-row-detail">
            <span className={`chip-inline status-${s.status}`}>{s.status}</span>
            <div className="session-row-main">
              <span className="session-label">{s.label}</span>
              <span className="session-meta">{s.summary}</span>
            </div>
            <span className="muted small mono">{relativeAge(s.started_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
