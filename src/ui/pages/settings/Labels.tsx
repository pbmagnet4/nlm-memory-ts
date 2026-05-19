import { useMemo, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { useDataset } from "../../lib/dataset.js";

export function SettingsLabelsPage() {
  const { data, loading, error } = useDataset();
  const [filter, setFilter] = useState("");
  const entities = data?.entities ?? [];
  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return entities;
    return entities.filter((e) => e.canonical.toLowerCase().includes(q) || e.type.toLowerCase().includes(q));
  }, [entities, filter]);

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <div className="page-header">
        <h2 className="page-title">Labels</h2>
        <input
          className="search-input"
          placeholder="filter entities…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {loading && !data && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}
      <p className="muted small">
        Read-only view. Promotion + retire actions land in a follow-up phase (NocoDB #95 action API port).
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Canonical</th>
            <th>Type</th>
            <th>Status</th>
            <th className="right">Sessions</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {filtered.slice(0, 200).map((e) => (
            <tr key={e.canonical}>
              <td className="canonical">
                <span className="dot" style={{ background: data?.entity_colors[e.canonical] ?? "#666" }} />
                {e.canonical}
              </td>
              <td><span className="chip-inline">{e.type}</span></td>
              <td><span className={`chip-inline status-${e.status}`}>{e.status}</span></td>
              <td className="right mono">{e.session_count}</td>
              <td className="mono small">{e.last_seen_session ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {filtered.length > 200 && <p className="muted small">Showing first 200 of {filtered.length}.</p>}
    </div>
  );
}
