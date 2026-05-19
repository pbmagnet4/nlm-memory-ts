import { useEffect, useMemo, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { useDataset } from "../../lib/dataset.js";
import { postAction } from "../../lib/actions.js";
import { TableRowSkeleton } from "../../components/Skeleton.js";

const LABEL_OPTIONS = ["candidate", "project", "tool", "contact", "service", "concept"];
const STATUS_OPTIONS = ["all", "active", "snoozed", "retired"] as const;
const SORT_OPTIONS = [
  { value: "sessions-desc", label: "Sessions (high → low)" },
  { value: "sessions-asc", label: "Sessions (low → high)" },
  { value: "name-asc", label: "Name (A → Z)" },
  { value: "name-desc", label: "Name (Z → A)" },
  { value: "recent", label: "Most recently seen" },
  { value: "oldest", label: "Least recently seen" },
] as const;
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

type StatusFilter = (typeof STATUS_OPTIONS)[number];
type SortKey = (typeof SORT_OPTIONS)[number]["value"];

export function SettingsLabelsPage() {
  const { data, loading, error, refetch } = useDataset();
  const [search, setSearch] = useState("");
  const [type, setType] = useState<string>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("sessions-desc");
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState(0);
  const [busyEntity, setBusyEntity] = useState<string | null>(null);

  const entities = data?.entities ?? [];

  const typeOptions = useMemo(() => {
    const seen = new Set<string>(LABEL_OPTIONS);
    for (const e of entities) seen.add(e.type);
    return ["all", ...[...seen].sort()];
  }, [entities]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const list = entities.filter((e) => {
      if (type !== "all" && e.type !== type) return false;
      if (status !== "all" && e.status !== status) return false;
      if (!q) return true;
      return e.canonical.toLowerCase().includes(q) || e.type.toLowerCase().includes(q);
    });
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sort) {
        case "sessions-desc": return b.session_count - a.session_count;
        case "sessions-asc": return a.session_count - b.session_count;
        case "name-asc": return a.canonical.localeCompare(b.canonical);
        case "name-desc": return b.canonical.localeCompare(a.canonical);
        case "recent": return (b.last_seen_session ?? "").localeCompare(a.last_seen_session ?? "");
        case "oldest": return (a.last_seen_session ?? "").localeCompare(b.last_seen_session ?? "");
      }
    });
    return sorted;
  }, [entities, search, type, status, sort]);

  useEffect(() => { setPage(0); }, [search, type, status, sort, pageSize]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  const mutate = async (entity: string, fn: () => Promise<void>) => {
    setBusyEntity(entity);
    try {
      await fn();
      await refetch();
    } finally {
      setBusyEntity(null);
    }
  };

  const relabel = (entity: string, newType: string) =>
    mutate(entity, () =>
      postAction({ kind: "label_entity", subject_type: "entity", subject_id: entity, payload: { new_type: newType } }).then(() => {}),
    );

  const retire = (entity: string) =>
    mutate(entity, () =>
      postAction({ kind: "retire_entity", subject_type: "entity", subject_id: entity }).then(() => {}),
    );

  const snooze = (entity: string) => {
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    return mutate(entity, () =>
      postAction({ kind: "snooze", subject_type: "entity", subject_id: entity, payload: { snoozed_until: until } }).then(() => {}),
    );
  };

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <div className="page-header">
        <h2 className="page-title">Labels</h2>
        <input
          className="search-input"
          placeholder="search canonical or type…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="thread-filters">
        <div className="filter-group" role="group" aria-label="Status filter">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip${status === s ? " active" : ""}`}
              onClick={() => setStatus(s)}
            >{s}</button>
          ))}
        </div>
        <div className="filter-group" role="group" aria-label="Type filter">
          <label className="form-label">Type</label>
          <select
            className="form-input form-input-inline"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="filter-group" role="group" aria-label="Sort">
          <label className="form-label">Sort</label>
          <select
            className="form-input form-input-inline"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <span className="header-spacer" />
        <span className="muted small">{filtered.length} match{filtered.length === 1 ? "" : "es"}</span>
      </div>

      {error && <div className="muted error">{error}</div>}
      <table className="data-table">
        <thead>
          <tr>
            <th>Canonical</th>
            <th>Type</th>
            <th>Status</th>
            <th className="right">Sessions</th>
            <th>Last seen</th>
            <th>Actions</th>
          </tr>
        </thead>
        {loading && !data && <TableRowSkeleton rows={8} cols={6} />}
        <tbody>
          {slice.map((e) => {
            const busy = busyEntity === e.canonical;
            return (
              <tr key={e.canonical} className={busy ? "row-busy" : ""}>
                <td className="canonical">
                  <span className="dot" style={{ background: data?.entity_colors[e.canonical] ?? "#666" }} />
                  {e.canonical}
                </td>
                <td>
                  <select
                    className="form-input form-input-inline"
                    value={LABEL_OPTIONS.includes(e.type) ? e.type : "candidate"}
                    onChange={(ev) => void relabel(e.canonical, ev.target.value)}
                    disabled={busy}
                  >
                    {LABEL_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </td>
                <td><span className={`chip-inline status-${e.status}`}>{e.status}</span></td>
                <td className="right mono">{e.session_count}</td>
                <td className="mono small">{e.last_seen_session ?? "—"}</td>
                <td className="row-actions">
                  <button type="button" className="chip" disabled={busy} onClick={() => void snooze(e.canonical)}>snooze 30d</button>
                  <button type="button" className="chip" disabled={busy} onClick={() => void retire(e.canonical)}>retire</button>
                </td>
              </tr>
            );
          })}
          {slice.length === 0 && (
            <tr><td colSpan={6} className="muted small empty-row">
              {entities.length === 0 ? "No entities yet." : "No entities match the current filters."}
            </td></tr>
          )}
        </tbody>
      </table>

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
      <p className="muted small">Changes are append-only actions; refresh re-applies the overlay over the persisted store.</p>
    </div>
  );
}
