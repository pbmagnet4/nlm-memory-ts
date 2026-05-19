import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDataset, relativeAge } from "../lib/dataset.js";

export function SearchPage() {
  const { data, loading, error } = useDataset();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const entity = params.get("entity") ?? "";

  const [input, setInput] = useState(q);

  const tokens = useMemo(() => {
    const norm = q.toLowerCase().split(/\s+/).filter(Boolean);
    return norm;
  }, [q]);

  const results = useMemo(() => {
    if (!data) return [];
    const sessions = entity
      ? data.sessions.filter((s) => s.entities.includes(entity))
      : data.sessions;
    if (tokens.length === 0) return sessions.slice(-50).reverse();
    const scored = sessions
      .map((s) => ({ session: s, score: score(s, tokens) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);
    return scored.map((x) => x.session);
  }, [data, tokens, entity]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(params);
    if (input) next.set("q", input);
    else next.delete("q");
    setParams(next);
  };

  return (
    <div className="page-pad">
      <form onSubmit={onSubmit} className="search-bar">
        <input
          className="search-input search-big"
          placeholder="search sessions, decisions, open questions…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
        />
        {entity && (
          <span className="chip-inline">
            entity: {entity}
            <button type="button" className="chip-x" onClick={() => { const n = new URLSearchParams(params); n.delete("entity"); setParams(n); }}>×</button>
          </span>
        )}
      </form>

      {loading && !data && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}

      <div className="muted small search-meta">
        {results.length} result{results.length === 1 ? "" : "s"}
      </div>

      <ul className="session-list compact">
        {results.map((s) => (
          <li key={s.id} className="session-row">
            <span className={`chip-inline status-${s.status}`}>{s.status}</span>
            <Link to={`/thread?entity=${encodeURIComponent(s.entities[0] ?? "")}`} className="session-label">
              {s.label}
            </Link>
            <span className="session-meta">{relativeAge(s.started_at)} · {s.entities.slice(0, 4).join(", ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function score(s: { label: string; summary: string; decisions: string[]; open: string[]; entities: string[] }, tokens: string[]): number {
  let total = 0;
  const label = s.label.toLowerCase();
  const summary = s.summary.toLowerCase();
  const decisions = s.decisions.join(" ").toLowerCase();
  const open = s.open.join(" ").toLowerCase();
  for (const t of tokens) {
    if (label.includes(t)) total += 3;
    if (decisions.includes(t)) total += 2;
    if (open.includes(t)) total += 2;
    if (summary.includes(t)) total += 1;
  }
  return total;
}
