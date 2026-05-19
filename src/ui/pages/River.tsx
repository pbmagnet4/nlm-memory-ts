import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDataset } from "../lib/dataset.js";

type Span = "7d" | "30d" | "90d" | "all";
const SPAN_DAYS: Record<Span, number | null> = { "7d": 7, "30d": 30, "90d": 90, all: null };

export function RiverPage() {
  const { data, loading, error } = useDataset();
  const [span, setSpan] = useState<Span>("30d");

  const view = useMemo(() => {
    if (!data) return null;
    const days = SPAN_DAYS[span];
    const sessions = data.sessions.filter((s) => s.started_at !== null);
    const now = Date.now();
    const filtered = days
      ? sessions.filter((s) => (now - Date.parse(s.started_at!)) / 86_400_000 <= days)
      : sessions;

    // group by (entity, date)
    const lanes = new Map<string, Map<string, number>>(); // entity → date → count
    const dateSet = new Set<string>();
    for (const s of filtered) {
      const d = (s.started_at ?? "").slice(0, 10);
      if (!d) continue;
      dateSet.add(d);
      for (const e of s.entities) {
        const inner = lanes.get(e) ?? new Map<string, number>();
        inner.set(d, (inner.get(d) ?? 0) + 1);
        lanes.set(e, inner);
      }
    }
    const dates = [...dateSet].sort();
    const laneRows = [...lanes.entries()]
      .map(([entity, perDate]) => ({
        entity,
        total: [...perDate.values()].reduce((a, b) => a + b, 0),
        perDate,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 24);
    return { dates, laneRows, total: filtered.length };
  }, [data, span]);

  if (loading && !data) return <div className="page-pad"><div className="muted">Loading dataset…</div></div>;
  if (error && !data) return <div className="page-pad"><div className="muted error">{error}</div></div>;
  if (!data || !view) return null;

  return (
    <div className="page-pad">
      <div className="river-toolbar">
        <span className="page-title">River</span>
        <span className="muted small">{view.total} sessions · {view.laneRows.length} lanes · {view.dates.length} days</span>
        <span className="header-spacer" />
        {(Object.keys(SPAN_DAYS) as Span[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`ctrl-btn${s === span ? " active" : ""}`}
            onClick={() => setSpan(s)}
          >{s}</button>
        ))}
      </div>

      <div className="river-grid card">
        <div className="river-dates">
          {view.dates.map((d) => (
            <div key={d} className="river-date-cell" title={d}>{d.slice(5)}</div>
          ))}
        </div>
        {view.laneRows.map(({ entity, perDate, total }) => (
          <div key={entity} className="river-lane">
            <Link to={`/thread?entity=${encodeURIComponent(entity)}`} className="river-lane-label">
              <span className="dot" style={{ background: data.entity_colors[entity] ?? "#666" }} />
              <span className="river-lane-name">{entity}</span>
              <span className="muted small">{total}</span>
            </Link>
            <div className="river-cells">
              {view.dates.map((d) => {
                const v = perDate.get(d) ?? 0;
                return (
                  <div
                    key={d}
                    className={`river-cell tier-${tier(v)}`}
                    title={`${entity} · ${d} · ${v} session${v === 1 ? "" : "s"}`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {view.laneRows.length === 0 && <div className="muted">No entities in this window.</div>}
    </div>
  );
}

function tier(v: number): 0 | 1 | 2 | 3 | 4 {
  if (v === 0) return 0;
  if (v === 1) return 1;
  if (v <= 3) return 2;
  if (v <= 6) return 3;
  return 4;
}
