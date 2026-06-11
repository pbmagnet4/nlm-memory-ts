import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDataset, relativeAge, topicDisplay } from "../lib/dataset.js";
import type { DatasetSession, Dataset } from "../lib/dataset.js";
import { SessionDrawer } from "../components/SessionDrawer.js";
import { MarkerActionMenu, type MarkerActionOption } from "../components/MarkerActionMenu.js";
import { SessionListSkeleton, Skeleton } from "../components/Skeleton.js";
import { readViewSettings, type ThreadSort } from "../lib/view-settings.js";
import { postAction } from "../lib/actions.js";
import { groupByReplaceChain } from "../lib/thread-groups.js";
import { fmt } from "../lib/format.js";
import { rowProps } from "../lib/rowProps.js";

export function ThreadPage() {
  const { data, loading, error, refetch } = useDataset();
  const [params, setParams] = useSearchParams();
  const entity = params.get("entity") ?? "";
  const drawerSid = params.get("session");

  const [sort, setSort] = useState<ThreadSort>(() => readViewSettings().threadSort);
  const [decisionsExpanded, setDecisionsExpanded] = useState(false);
  const [openExpanded, setOpenExpanded] = useState(false);

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
  const entityLabel = topicDisplay(data, entity);
  const isRenamed = entity !== entityLabel;

  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  useEffect(() => {
    if (entity && data) document.title = `${entityLabel} — Thread`;
  }, [entity, entityLabel, data]);

  const beginRename = () => {
    setRenameDraft(entityLabel);
    setRenaming(true);
  };

  const cancelRename = () => {
    setRenaming(false);
    setRenameDraft("");
  };

  const commitRename = async () => {
    const next = renameDraft.trim();
    if (!next) { cancelRename(); return; }
    setRenameBusy(true);
    try {
      await postAction({
        kind: "rename_entity",
        subject_type: "entity",
        subject_id: entity,
        payload: { to: next === entity ? "" : next },
      });
      await refetch();
    } finally {
      setRenameBusy(false);
      setRenaming(false);
      setRenameDraft("");
    }
  };

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
      <div className="thread-sessions-head-mt"><SessionListSkeleton rows={8} /></div>
    </div>
  );
  if (error && !data) return <div className="page-pad"><div className="muted error">{error}</div></div>;
  if (!data) return null;

  if (!entity) {
    return <EntityPicker data={data} />;
  }

  const decisions = thread.flatMap((s) =>
    s.decisions.map((d, idx) => ({ d, id: s.decision_ids[idx] ?? "", sid: s.id, when: s.started_at })),
  );
  const open = thread.flatMap((s) =>
    s.open_questions.map((q) => ({ id: q.id, q: q.text, sid: s.id, when: s.started_at })),
  );

  const decisionActions = (id: string, currentText: string): MarkerActionOption[] => [
    {
      value: "revise",
      label: "revise",
      kind: "editor",
      buildAction: (to) => ({
        kind: "revise_decision",
        subject_type: "decision",
        subject_id: id,
        payload: { to, original_text: currentText },
      }),
    },
    {
      value: "dismiss",
      label: "dismiss",
      kind: "instant",
      action: { kind: "dismiss_decision", subject_type: "decision", subject_id: id },
    },
  ];

  const openActions = (id: string, currentText: string): MarkerActionOption[] => [
    {
      value: "decide",
      label: "decide",
      kind: "editor",
      buildAction: (resolution) => ({
        kind: "promote_open",
        subject_type: "open_question",
        subject_id: id,
        payload: { resolution, original_text: currentText },
      }),
    },
    {
      value: "resolve",
      label: "resolve",
      kind: "instant",
      action: { kind: "resolve_open", subject_type: "open_question", subject_id: id },
    },
  ];


  return (
    <div className="page-pad">
      <div className="thread-header">
        <span className="dot lg" style={{ background: entityColor }} />
        {renaming ? (
          <input
            className="form-input form-input-inline"
            autoFocus
            value={renameDraft}
            disabled={renameBusy}
            onChange={(ev) => setRenameDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") { ev.preventDefault(); void commitRename(); }
              else if (ev.key === "Escape") { ev.preventDefault(); cancelRename(); }
            }}
            onBlur={() => void commitRename()}
            aria-label={`Rename topic ${entity}`}
          />
        ) : (
          <h2 className="page-title" title={isRenamed ? `Original: ${entity}` : undefined}>{entityLabel}</h2>
        )}
        {!renaming && (
          <button
            type="button"
            className="chip"
            onClick={beginRename}
            title="Rename this topic. Recall still resolves the original name."
          >rename</button>
        )}
        <span className="muted">{fmt.plural(thread.filter((s) => s.status !== "replaced").length, "session")}</span>
        <span className="header-spacer" />
        <div className="filter-group" role="group" aria-label="Sort order">
          {(["recent", "oldest"] as const).map((s) => (
            <button key={s} type="button" className={`chip${sort === s ? " active" : ""}`} onClick={() => setSort(s)}>
              {s === "recent" ? "recent first" : "oldest first"}
            </button>
          ))}
        </div>
      </div>

      <div className="thread-grid">
        <section className="card">
          <header className="card-head"><h3>Decisions</h3><span className="muted small">{decisions.length}</span></header>
          <ul className="marker-list">
            {(decisionsExpanded ? decisions : decisions.slice(0, 30)).map((d, i) => (
              <li key={`${d.id}-${i}`} className="marker-row marker-row-promotable">
                <span className="live-tag" data-kind="decision">decision</span>
                <button
                  type="button"
                  className="link-button muted small marker-timestamp"
                  onClick={() => openSession(d.sid)}
                  title="Open source session"
                >{relativeAge(d.when)}</button>
                <span className="marker-text">{d.d}</span>
                <div className="marker-actions">
                  {d.id && (
                    <MarkerActionMenu
                      options={decisionActions(d.id, d.d)}
                      editorSeed={d.d}
                      onChanged={refetch}
                    />
                  )}
                </div>
              </li>
            ))}
            {decisions.length === 0 && <li className="muted empty-row">No decisions captured yet.</li>}
            {decisions.length > 30 && (
              <li className="list-action-row">
                <button type="button" className="link-button" onClick={() => setDecisionsExpanded((v) => !v)}>
                  {decisionsExpanded ? "Show less" : `Showing 30 of ${decisions.length} — show all`}
                </button>
              </li>
            )}
          </ul>
        </section>

        <section className="card">
          <header className="card-head"><h3>Open questions</h3><span className="muted small">{open.length}</span></header>
          <ul className="marker-list">
            {(openExpanded ? open : open.slice(0, 30)).map((o, i) => (
              <li key={`${o.id}-${i}`} className="marker-row marker-row-promotable">
                <span className="live-tag" data-kind="open">open</span>
                <button
                  type="button"
                  className="link-button muted small marker-timestamp"
                  onClick={() => openSession(o.sid)}
                  title="Open source session"
                >{relativeAge(o.when)}</button>
                <span className="marker-text">{o.q}</span>
                <div className="marker-actions">
                  <MarkerActionMenu
                    options={openActions(o.id, o.q)}
                    editorSeed={o.q}
                    onChanged={refetch}
                  />
                </div>
              </li>
            ))}
            {open.length === 0 && <li className="muted empty-row">No open questions captured yet.</li>}
            {open.length > 30 && (
              <li className="list-action-row">
                <button type="button" className="link-button" onClick={() => setOpenExpanded((v) => !v)}>
                  {openExpanded ? "Show less" : `Showing 30 of ${open.length} — show all`}
                </button>
              </li>
            )}
          </ul>
        </section>
      </div>

      <ThreadSessionList thread={thread} entity={entity} onOpenSession={openSession} />

      {drawerSid && (() => {
        const idx = thread.findIndex((s) => s.id === drawerSid);
        const prevId = idx < thread.length - 1 ? thread[idx + 1]!.id : null;
        const nextId = idx > 0 ? thread[idx - 1]!.id : null;
        return (
          <SessionDrawer
            sessionId={drawerSid}
            onClose={closeSession}
            onNavigate={openSession}
            prevSessionId={prevId}
            nextSessionId={nextId}
            entityColor={entityColor}
          />
        );
      })()}
    </div>
  );
}

type StatusFilter = "all" | "active" | "idle" | "closed" | "superseded";
type MarkerFilter = "all" | "decisions" | "open";
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

function ThreadSessionList({
  thread,
  entity,
  onOpenSession,
}: {
  thread: DatasetSession[];
  entity: string;
  onOpenSession: (id: string) => void;
}) {
  const [runtimeFilter, setRuntimeFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [markers, setMarkers] = useState<MarkerFilter>("all");
  const [pageSize, setPageSize] = useState<number>(25);
  const [page, setPage] = useState(0);
  // Track which chain-heads have their earlier versions expanded.
  const [expandedChains, setExpandedChains] = useState<Set<string>>(new Set());

  const threadRuntimes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of thread) counts.set(s.runtime, (counts.get(s.runtime) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  }, [thread]);

  // Filter across all visible sessions (live + already-expanded replaced).
  // Replaced sessions that are collapsed are excluded from filter matching
  // and count tallies, consistent with the "noise" framing.
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return thread.filter((s) => {
      if (s.status === "replaced") return false;
      if (runtimeFilter !== "all" && s.runtime !== runtimeFilter) return false;
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
  }, [thread, query, status, markers, runtimeFilter]);

  // Reset page when filter inputs change
  useEffect(() => { setPage(0); }, [query, status, markers, pageSize, runtimeFilter]);

  // Reset runtime filter when entity changes
  useEffect(() => { setRuntimeFilter("all"); }, [entity]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  // Build replace-chain groups for the current page slice only.
  const groups = useMemo(() => groupByReplaceChain(slice), [slice]);

  const toggleChain = (headId: string) => {
    setExpandedChains((prev) => {
      const next = new Set(prev);
      if (next.has(headId)) next.delete(headId);
      else next.add(headId);
      return next;
    });
  };

  return (
    <>
      <div className="thread-sessions-head">
        <h3 className="section-title thread-sessions-title">Sessions</h3>
        <div className="search-wrap">
          <input
            className="search-input"
            placeholder="search label, summary, decisions, open…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
          />
          {query && (
            <button type="button" className="search-clear" onClick={() => setQuery("")} aria-label="Clear search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>
      </div>

      <div className="thread-filters">
        {threadRuntimes.length > 1 && (
          <div className="filter-group" role="group" aria-label="Agent filter">
            <button
              type="button"
              className={`chip${runtimeFilter === "all" ? " active" : ""}`}
              onClick={() => setRuntimeFilter("all")}
            >all</button>
            {threadRuntimes.map((r) => {
              const count = thread.filter((s) => s.status !== "replaced" && s.runtime === r).length;
              return (
                <button
                  key={r}
                  type="button"
                  className={`chip${runtimeFilter === r ? " active" : ""}`}
                  onClick={() => setRuntimeFilter(r)}
                >{r} · {count}</button>
              );
            })}
          </div>
        )}
        <div className="filter-group" role="group" aria-label="Status filter">
          {(["all", "active", "idle", "closed", "superseded"] as const).map((s) => {
            const count = s === "all"
              ? thread.filter((x) => x.status !== "replaced").length
              : thread.filter((x) => x.status === s).length;
            return (
              <button
                key={s}
                type="button"
                className={`chip${status === s ? " active" : ""}`}
                data-status={s === "all" ? undefined : s}
                onClick={() => setStatus(s)}
              >{s} · {count}</button>
            );
          })}
        </div>
        <div className="filter-group" role="group" aria-label="Marker filter">
          {(["all", "decisions", "open"] as const).map((m) => {
            const count = m === "decisions"
              ? thread.filter((s) => s.status !== "replaced" && s.decisions.length > 0).length
              : thread.filter((s) => s.status !== "replaced" && s.open_questions.length > 0).length;
            return (
              <button
                key={m}
                type="button"
                className={`chip${markers === m ? " active" : ""}`}
                data-marker={m === "all" ? undefined : m}
                onClick={() => setMarkers(m)}
              >{m === "all" ? "all" : `${m} · ${count}`}</button>
            );
          })}
        </div>
        <span className="header-spacer" />
        <span className="muted small">{filtered.length} match{filtered.length === 1 ? "" : "es"}</span>
      </div>

      <ul className="session-list">
        {groups.map((item) => {
          if (item.kind === "orphan") {
            const s = item.session;
            return (
              <li key={s.id} className="session-row session-row-detail clickable" {...rowProps(() => onOpenSession(s.id))}>
                <span className={`chip-inline status-${s.status}`}>{s.status}</span>
                <div className="session-row-main">
                  <span className="session-label">{s.label}</span>
                  <span className="session-meta">{s.summary}</span>
                </div>
                <span className="muted small mono">{relativeAge(s.started_at)}</span>
              </li>
            );
          }

          const { live, earlier } = item.group;
          const isExpanded = expandedChains.has(live.id);

          return (
            <li key={live.id}>
              <div className="session-row session-row-detail clickable" {...rowProps(() => onOpenSession(live.id))}>
                <span className={`chip-inline status-${live.status}`}>{live.status}</span>
                <div className="session-row-main">
                  <span className="session-label">{live.label}</span>
                  <span className="session-meta">{live.summary}</span>
                </div>
                <div className="session-row-end" onClick={(e) => e.stopPropagation()}>
                  {earlier.length > 0 && (
                    <button
                      type="button"
                      className="chip earlier-versions-btn"
                      onClick={() => toggleChain(live.id)}
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? "Collapse" : "Expand"} ${fmt.plural(earlier.length, "earlier version")}`}
                    >
                      {isExpanded ? "hide" : fmt.plural(earlier.length, "earlier version")}
                    </button>
                  )}
                  <span className="muted small mono">{relativeAge(live.started_at)}</span>
                </div>
              </div>
              {isExpanded && earlier.length > 0 && (
                <ul className="earlier-versions-list">
                  {earlier.map((s) => (
                    <li
                      key={s.id}
                      className="session-row session-row-detail clickable is-replaced"
                      {...rowProps(() => onOpenSession(s.id))}
                    >
                      <span className="chip-inline status-replaced">replaced</span>
                      <div className="session-row-main">
                        <span className="session-label">{s.label}</span>
                        <span className="session-meta">{s.summary}</span>
                      </div>
                      <span className="muted small mono">{relativeAge(s.started_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {groups.length === 0 && (
          <li className="muted empty-row">
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

type EntitySort = "most-active" | "least-active" | "a-z" | "z-a";
const ENTITY_PAGE_SIZE_OPTIONS = [24, 48, 96] as const;

function EntityPicker({ data }: { data: Dataset }) {
  const [runtimeFilter, setRuntimeFilter] = useState<string>("all");
  const [entitySearch, setEntitySearch] = useState("");
  const [sort, setSort] = useState<EntitySort>("most-active");
  const [pageSize, setPageSize] = useState<number>(48);
  const [page, setPage] = useState(0);

  const entityRuntimeMap = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const s of data.sessions) {
      for (const e of s.entities) {
        let set = m.get(e);
        if (!set) { set = new Set(); m.set(e, set); }
        set.add(s.runtime);
      }
    }
    return m;
  }, [data.sessions]);

  const sortedRuntimes = useMemo(() => {
    return [...data.runtimes].sort((a, b) => b.sessions_total - a.sessions_total);
  }, [data.runtimes]);

  const filtered = useMemo(() => {
    const q = entitySearch.toLowerCase().trim();
    const matches = q
      ? data.entities.filter((e) =>
          e.canonical.toLowerCase().includes(q) ||
          (e.display ?? "").toLowerCase().includes(q),
        )
      : [...data.entities];
    const result = runtimeFilter === "all"
      ? matches
      : matches.filter((e) => entityRuntimeMap.get(e.canonical)?.has(runtimeFilter) ?? false);
    const labelOf = (e: typeof data.entities[number]) => e.display ?? e.canonical;
    result.sort((a, b) => {
      if (sort === "most-active") return b.session_count - a.session_count;
      if (sort === "least-active") return a.session_count - b.session_count;
      if (sort === "a-z") return labelOf(a).localeCompare(labelOf(b));
      return labelOf(b).localeCompare(labelOf(a));
    });
    return result;
  }, [data.entities, entitySearch, sort, runtimeFilter, entityRuntimeMap]);

  useEffect(() => { setPage(0); }, [entitySearch, sort, pageSize, runtimeFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  return (
    <div className="page-pad">
      <h2 className="page-title">Thread</h2>
      <p className="muted">Pick a topic to view its reasoning history.</p>
      <div className="thread-sessions-head thread-sessions-head-mt">
        <div className="search-wrap search-wrap-compact">
          <input
            className="search-input"
            placeholder="search topics…"
            value={entitySearch}
            onChange={(e) => setEntitySearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setEntitySearch(""); }}
          />
          {entitySearch && (
            <button type="button" className="search-clear" onClick={() => setEntitySearch("")} aria-label="Clear search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>
        <span className="header-spacer" />
        <span className="muted small">
          {entitySearch
            ? `${filtered.length} of ${data.entities.length} topics`
            : `${data.entities.length} topics`}
        </span>
      </div>
      <div className="thread-filters">
        <div className="filter-group" role="group" aria-label="Agent filter">
          <button
            type="button"
            className={`chip${runtimeFilter === "all" ? " active" : ""}`}
            onClick={() => setRuntimeFilter("all")}
          >all</button>
          {sortedRuntimes.map((r) => (
            <button
              key={r.name}
              type="button"
              className={`chip${runtimeFilter === r.name ? " active" : ""}`}
              onClick={() => setRuntimeFilter(r.name)}
            >{r.name} · {r.sessions_total}</button>
          ))}
        </div>
        <div className="filter-group" role="group" aria-label="Sort order">
          {(["most-active", "least-active", "a-z", "z-a"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`chip${sort === s ? " active" : ""}`}
              onClick={() => setSort(s)}
            >
              {s === "most-active" ? "most active" : s === "least-active" ? "least active" : s}
            </button>
          ))}
        </div>
      </div>
      <ul className="entity-grid">
        {slice.map((e) => (
          <li key={e.canonical}>
            <Link to={`/thread?entity=${encodeURIComponent(e.canonical)}`} className="card card-lift entity-card">
              <span className="dot" style={{ background: data.entity_colors[e.canonical] ?? "#666" }} />
              <span className="entity-name" title={e.display ? `Original: ${e.canonical}` : undefined}>{e.display ?? e.canonical}</span>
              <span className="muted small">{e.session_count}</span>
            </Link>
          </li>
        ))}
        {slice.length === 0 && (
          <li className="empty-row-full-width muted empty-row">No topics match.</li>
        )}
      </ul>
      {filtered.length > pageSize && (
        <div className="pagination">
          <div className="page-size">
            <label className="form-label">Per page</label>
            <select
              className="form-input form-input-inline"
              value={pageSize}
              onChange={(e) => setPageSize(Number.parseInt(e.target.value, 10))}
            >
              {ENTITY_PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
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
    </div>
  );
}
