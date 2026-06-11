import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDataset, relativeAge } from "../lib/dataset.js";
import { SessionDrawer } from "../components/SessionDrawer.js";
import { rowProps } from "../lib/rowProps.js";

type MatchedField = "label" | "entity" | "decision" | "open" | "summary";
type SortMode = "relevance" | "recent";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

function score(
  s: { label: string; summary: string; decisions: string[]; open: string[]; entities: string[] },
  tokens: string[],
  phrase: string,
): { score: number; matchedField: MatchedField } {
  const label = s.label.toLowerCase();
  const summary = s.summary.toLowerCase();
  const decisionsJoined = s.decisions.join(" ").toLowerCase();
  const openJoined = s.open.join(" ").toLowerCase();

  const fieldScores: Record<MatchedField, number> = {
    label: 0,
    entity: 0,
    decision: 0,
    open: 0,
    summary: 0,
  };

  for (const t of tokens) {
    if (label.includes(t)) fieldScores.label += 3;
    for (const e of s.entities) {
      const el = e.toLowerCase();
      if (el === t) { fieldScores.entity += 4; break; }
      else if (el.includes(t)) { fieldScores.entity += 2; break; }
    }
    if (decisionsJoined.includes(t)) fieldScores.decision += 2;
    if (openJoined.includes(t)) fieldScores.open += 2;
    if (summary.includes(t)) fieldScores.summary += 1;
  }

  if (phrase && (label.includes(phrase) || decisionsJoined.includes(phrase) || openJoined.includes(phrase))) {
    const topField = (Object.keys(fieldScores) as MatchedField[]).reduce((a, b) =>
      fieldScores[a] >= fieldScores[b] ? a : b
    );
    fieldScores[topField] += 5;
  }

  const total = Object.values(fieldScores).reduce((a, b) => a + b, 0);

  const priority: MatchedField[] = ["label", "entity", "decision", "open", "summary"];
  let matchedField: MatchedField = "summary";
  let best = -1;
  for (const f of priority) {
    if (fieldScores[f] > best) { best = fieldScores[f]; matchedField = f; }
  }

  return { score: total, matchedField };
}

function buildSnippet(text: string, tokens: string[], radius = 60): string {
  const lower = text.toLowerCase();
  let best = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  if (best === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, best - radius);
  const end = Math.min(text.length, best + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function highlightTokens(text: string, tokens: string[]): string {
  let escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const t of tokens) {
    escaped = escaped.replace(
      new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      (m) => `<mark>${m}</mark>`,
    );
  }
  return escaped;
}

export function SearchPage() {
  const { data, loading, error } = useDataset();
  const [params, setParams] = useSearchParams();

  const q = params.get("q") ?? "";
  const [input, setInput] = useState(q);

  const [entityFilter, setEntityFilter] = useState(params.get("entity") ?? "");
  const [runtimeFilter, setRuntimeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortMode, setSortMode] = useState<SortMode>("recent");

  const [pageSize, setPageSize] = useState<number>(25);
  const [page, setPage] = useState(0);

  const [drawerSid, setDrawerSid] = useState<string | null>(params.get("session"));

  const openSession = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("session", id);
    setParams(next);
    setDrawerSid(id);
  };

  const closeSession = () => {
    const next = new URLSearchParams(params);
    next.delete("session");
    setParams(next);
    setDrawerSid(null);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (input) next.set("q", input); else next.delete("q");
      setParams(next);
    }, 200);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (entityFilter) next.set("entity", entityFilter); else next.delete("entity");
    setParams(next);
  }, [entityFilter]);

  const tokens = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const phrase = tokens.join(" ");

  const results = useMemo(() => {
    if (!data) return [];

    const filtered = data.sessions.filter((s) => {
      if (s.status === "replaced") return false;
      if (entityFilter && !s.entities.includes(entityFilter)) return false;
      if (runtimeFilter !== "all" && s.runtime !== runtimeFilter) return false;
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      return true;
    });

    if (tokens.length === 0) {
      const sorted = [...filtered].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
      return sorted.map((session) => ({ session, score: 0, matchedField: "summary" as MatchedField }));
    }

    const scored = filtered
      .map((s) => {
        const { score: sc, matchedField } = score(s, tokens, phrase);
        return { session: s, score: sc, matchedField };
      })
      .filter((x) => x.score > 0);

    if (sortMode === "recent") {
      scored.sort((a, b) => (b.session.started_at ?? "").localeCompare(a.session.started_at ?? ""));
    } else {
      scored.sort((a, b) => b.score - a.score);
    }

    return scored;
  }, [data, tokens, phrase, entityFilter, runtimeFilter, statusFilter, sortMode]);

  useEffect(() => { setPage(0); }, [results, runtimeFilter, statusFilter, entityFilter]);

  const pageCount = Math.max(1, Math.ceil(results.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const slice = results.slice(start, start + pageSize);

  const availableRuntimes = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    for (const s of data.sessions) counts.set(s.runtime, (counts.get(s.runtime) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  }, [data]);

  const topEntities = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { session: s } of results) {
      for (const e of s.entities) counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
  }, [results]);

  const anyFilterActive = q !== "" || entityFilter !== "" || runtimeFilter !== "all" || statusFilter !== "all";

  const clearAllFilters = () => {
    setInput("");
    setEntityFilter("");
    setRuntimeFilter("all");
    setStatusFilter("all");
    setSortMode("recent");
    const next = new URLSearchParams();
    if (drawerSid) next.set("session", drawerSid);
    setParams(next);
  };

  const idx = slice.findIndex((r) => r.session.id === drawerSid);
  const prevId = idx < slice.length - 1 ? slice[idx + 1]!.session.id : null;
  const nextId = idx > 0 ? slice[idx - 1]!.session.id : null;

  return (
    <div className="page-pad">
      <div className="search-header">
        <form onSubmit={(e) => e.preventDefault()} className="search-bar">
          <div className="search-wrap search-wrap-full">
            <input
              className="search-input search-big"
              placeholder="search sessions, decisions, open questions…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoFocus
            />
            {input.length > 0 && (
              <button type="button" className="search-clear" onClick={() => setInput("")} aria-label="Clear search">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </form>

        <div className="thread-filters">
          {availableRuntimes.length > 1 && (
            <div className="filter-group" role="group" aria-label="Agent filter">
              <button type="button" className={`chip${runtimeFilter === "all" ? " active" : ""}`} onClick={() => setRuntimeFilter("all")}>all</button>
              {availableRuntimes.map((r) => {
                const count = results.filter((x) => x.session.runtime === r).length;
                return (
                  <button key={r} type="button" className={`chip${runtimeFilter === r ? " active" : ""}`} onClick={() => setRuntimeFilter(r)}>
                    {r} · {count}
                  </button>
                );
              })}
            </div>
          )}

          <div className="filter-group" role="group" aria-label="Status filter">
            {(["all", "active", "idle", "closed", "superseded"] as const).map((s) => {
              const count = s === "all" ? results.length : results.filter((x) => x.session.status === s).length;
              return (
                <button
                  key={s}
                  type="button"
                  className={`chip${statusFilter === s ? " active" : ""}`}
                  data-status={s === "all" ? undefined : s}
                  onClick={() => setStatusFilter(s)}
                >{s} · {count}</button>
              );
            })}
          </div>

          {q !== "" && (
            <div className="filter-group" role="group" aria-label="Sort order">
              {(["relevance", "recent"] as const).map((m) => (
                <button key={m} type="button" className={`chip${sortMode === m ? " active" : ""}`} onClick={() => setSortMode(m)}>{m}</button>
              ))}
            </div>
          )}

          {topEntities.length > 0 && (
            <div className="filter-group thread-filters-wrap" role="group" aria-label="Topic filter">
              <button type="button" className={`chip${entityFilter === "" ? " active" : ""}`} onClick={() => setEntityFilter("")}>all topics</button>
              {topEntities.slice(0, 12).map((e) => (
                <button key={e} type="button" className={`chip${entityFilter === e ? " active" : ""}`} onClick={() => setEntityFilter(entityFilter === e ? "" : e)} title={data?.entity_display[e] ? `Original: ${e}` : undefined}>{data?.entity_display[e] ?? e}</button>
              ))}
              {topEntities.length > 12 && (
                <select
                  className="form-input form-input-inline"
                  value={entityFilter}
                  onChange={(e) => setEntityFilter(e.target.value)}
                >
                  <option value="">more topics…</option>
                  {topEntities.slice(12).map((e) => (
                    <option key={e} value={e}>{data?.entity_display[e] ?? e}</option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
      </div>

      {loading && !data && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}

      {!anyFilterActive && <p className="muted small search-hint">Showing recent sessions. Type to search across labels, decisions, open questions, and summaries.</p>}

      <div className="muted small search-meta">
        {results.length} result{results.length === 1 ? "" : "s"}
        {anyFilterActive && (
          <button type="button" className="link-button search-meta-clear" onClick={clearAllFilters}>
            clear filters
          </button>
        )}
      </div>

      <ul className="session-list">
        {slice.map(({ session: s, matchedField }) => {
          let snippetText = s.summary;
          if (tokens.length > 0) {
            if (matchedField === "decision") {
              snippetText = s.decisions.find((d) => tokens.some((t) => d.toLowerCase().includes(t))) ?? s.summary;
            } else if (matchedField === "open") {
              snippetText = s.open.find((o) => tokens.some((t) => o.toLowerCase().includes(t))) ?? s.summary;
            }
          }

          return (
            <li
              key={s.id}
              className={`session-row session-row-detail clickable${drawerSid === s.id ? " is-selected" : ""}`}
              {...rowProps(() => openSession(s.id))}
            >
              <span className={`chip-inline status-${s.status}`}>{s.status}</span>
              <div className="session-row-main">
                <span className="session-label">{s.label}</span>
                <span className="session-meta">
                  {s.entities.slice(0, 4).map((e) => (
                    <span key={e} className="chip-inline session-meta-entity">{e}</span>
                  ))}
                </span>
                {tokens.length > 0 && (
                  <>
                    <span className="live-tag" data-kind={matchedField}>{matchedField}</span>
                    <div
                      className="match-snippet"
                      dangerouslySetInnerHTML={{ __html: highlightTokens(buildSnippet(snippetText, tokens), tokens) }}
                    />
                  </>
                )}
              </div>
              <div className="session-row-end-col">
                <span className="muted small mono">{relativeAge(s.started_at)}</span>
                <span className="chip-inline">{s.runtime}</span>
              </div>
            </li>
          );
        })}
        {slice.length === 0 && data && (
          <li className="muted empty-row">
            {results.length === 0 ? "No sessions match the current filters." : "No sessions on this page."}
          </li>
        )}
      </ul>

      {results.length > 0 && (
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
            {start + 1}&ndash;{Math.min(start + pageSize, results.length)} of {results.length}
          </span>
          <div className="page-nav">
            <button type="button" className="chip" disabled={currentPage === 0} onClick={() => setPage(0)}>&laquo; first</button>
            <button type="button" className="chip" disabled={currentPage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>&lsaquo; prev</button>
            <span className="page-indicator mono">{currentPage + 1} / {pageCount}</span>
            <button type="button" className="chip" disabled={currentPage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>next &rsaquo;</button>
            <button type="button" className="chip" disabled={currentPage >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>last &raquo;</button>
          </div>
        </div>
      )}

      {drawerSid && (
        <SessionDrawer
          sessionId={drawerSid}
          onClose={closeSession}
          onNavigate={openSession}
          prevSessionId={prevId}
          nextSessionId={nextId}
        />
      )}
    </div>
  );
}
