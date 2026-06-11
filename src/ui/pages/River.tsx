import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDataset, relativeAge } from "../lib/dataset.js";
import type { DatasetSession } from "../lib/dataset.js";
import { SessionDrawer } from "../components/SessionDrawer.js";
import { Drawer } from "../components/Drawer.js";
import { Skeleton } from "../components/Skeleton.js";
import { rowProps } from "../lib/rowProps.js";
import { readViewSettings } from "../lib/view-settings.js";

type Span = "7d" | "30d" | "90d" | "all";
const SPAN_DAYS: Record<Span, number | null> = { "7d": 7, "30d": 30, "90d": 90, all: null };

interface HoverState {
  entity: string;
  date: string;
  count: number;
  superseded: number;
  x: number;
  y: number;
}

interface DragState {
  startX: number;
  rect: DOMRect;
}

interface CellDrawerState {
  entity: string;
  date: string;
  sessions: DatasetSession[];
}

export function RiverPage() {
  const { data, loading, error } = useDataset();
  const [span, setSpan] = useState<Span>("30d");
  const [hover, setHover] = useState<HoverState | null>(null);
  const [cellDrawer, setCellDrawer] = useState<CellDrawerState | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const navigate = useNavigate();
  const [density] = useState(() => readViewSettings().riverDensity);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragRange, setDragRange] = useState<{ from: number; to: number } | null>(null);

  const view = useMemo(() => {
    if (!data) return null;
    const days = SPAN_DAYS[span];
    const sessions = data.sessions.filter((s) => s.started_at !== null);
    const now = Date.now();
    const filtered = days
      ? sessions.filter((s) => (now - Date.parse(s.started_at!)) / 86_400_000 <= days)
      : sessions;
    const lanes = new Map<string, Map<string, number>>();
    const supersededLanes = new Map<string, Map<string, number>>();
    const dateSet = new Set<string>();
    for (const s of filtered) {
      const d = (s.started_at ?? "").slice(0, 10);
      if (!d) continue;
      dateSet.add(d);
      const isSuperseded = s.status === "superseded";
      for (const e of s.entities) {
        if (isSuperseded) {
          const inner = supersededLanes.get(e) ?? new Map<string, number>();
          inner.set(d, (inner.get(d) ?? 0) + 1);
          supersededLanes.set(e, inner);
        } else {
          const inner = lanes.get(e) ?? new Map<string, number>();
          inner.set(d, (inner.get(d) ?? 0) + 1);
          lanes.set(e, inner);
        }
      }
    }
    // Ensure every entity that only has superseded sessions still appears
    for (const [e] of supersededLanes) {
      if (!lanes.has(e)) lanes.set(e, new Map());
    }
    const dates = [...dateSet].sort();
    const laneRows = [...lanes.entries()]
      .map(([entity, perDate]) => ({
        entity,
        total: [...perDate.values()].reduce((a, b) => a + b, 0),
        perDate,
        supersededPerDate: supersededLanes.get(entity) ?? new Map<string, number>(),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 24);
    const recentEntities = new Set<string>(
      filtered
        .filter(s => s.started_at && (now - Date.parse(s.started_at)) < 86_400_000)
        .flatMap(s => s.entities)
    );
    return { dates, laneRows, total: filtered.length, recentEntities };
  }, [data, span]);

  const onCellClick = (entity: string, date: string) => {
    if (!data) return;
    const matches = data.sessions
      .filter((s) => (s.started_at ?? "").slice(0, 10) === date && s.entities.includes(entity))
      .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
    if (matches.length === 0) return;
    if (matches.length === 1) {
      setSessionId(matches[0]!.id);
      return;
    }
    setCellDrawer({ entity, date, sessions: matches });
  };

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    dragRef.current = { startX: e.clientX, rect };
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const { startX, rect } = dragRef.current;
    const from = Math.min(startX, e.clientX) - rect.left;
    const to = Math.max(startX, e.clientX) - rect.left;
    if (to - from < 6) {
      setDragRange(null);
      return;
    }
    setDragRange({ from, to });
  };

  const onMouseUp = () => {
    if (!dragRef.current || !dragRange || !view) {
      dragRef.current = null;
      setDragRange(null);
      return;
    }
    // Cells live in a CSS grid with repeat(N, 1fr); compute the cell-area
    // width by measuring the rendered grid minus the fixed label column.
    const grid = gridRef.current;
    const labelEl = grid?.querySelector(".river-lane-label") as HTMLElement | null;
    const labelWidth = labelEl?.offsetWidth ?? 0;
    const gridWidth = grid?.offsetWidth ?? 0;
    const cellArea = Math.max(1, gridWidth - labelWidth);
    const cellSize = cellArea / view.dates.length;
    const labelOffset = labelWidth + 12; // grid padding + gap

    const startIdx = Math.max(0, Math.floor((dragRange.from - labelOffset) / cellSize));
    const endIdx = Math.min(view.dates.length - 1, Math.floor((dragRange.to - labelOffset) / cellSize));
    if (endIdx <= startIdx) {
      dragRef.current = null;
      setDragRange(null);
      return;
    }
    const startDate = view.dates[startIdx];
    const endDate = view.dates[endIdx];
    if (startDate && endDate) {
      const days = Math.max(1, Math.ceil((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000));
      setSpan(days <= 7 ? "7d" : days <= 30 ? "30d" : days <= 90 ? "90d" : "all");
    }
    dragRef.current = null;
    setDragRange(null);
  };

  if (loading && !data) return (
    <div className="page-pad">
      <div className="river-toolbar"><Skeleton h={22} w={80} /></div>
      <div className="card river-card-skeleton">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="river-row river-row-skeleton">
            <Skeleton h={14} w={160} />
            <Skeleton h={20} />
          </div>
        ))}
      </div>
    </div>
  );
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
        <div className="river-legend" aria-label="Activity scale">
          <span className="muted small">less</span>
          {([0, 1, 2, 3, 4] as const).map((t) => (
            <span key={t} className={`river-legend-cell tier-${t}`} />
          ))}
          <span className="muted small">more</span>
        </div>
      </div>

      <div
        className={`river-grid card river-density-${density}`}
        ref={gridRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { dragRef.current = null; setDragRange(null); setHover(null); }}
        style={{ ["--cells" as string]: view.dates.length }}
      >
        {dragRange && (
          <div
            className="river-drag-rect"
            style={{ left: `${dragRange.from}px`, width: `${dragRange.to - dragRange.from}px` }}
          />
        )}
        <div className="river-row river-row-dates">
          <div className="river-lane-label river-lane-label--header" aria-hidden="true" />
          <div className="river-cells">
            {(() => {
              const len = view.dates.length;
              const stride = len <= 60 ? 1 : len <= 120 ? 2 : len <= 250 ? 7 : 14;
              return view.dates.map((d, index) => {
                const isMonthStart = d.slice(8, 10) === "01";
                const cls = ["river-date-cell", isMonthStart ? "river-date-cell--month-start" : ""].filter(Boolean).join(" ");
                return (
                  <div key={d} className={cls} title={d}>
                    {index % stride === 0 ? d.slice(5) : ""}
                  </div>
                );
              });
            })()}
          </div>
        </div>
        {view.laneRows.map(({ entity, perDate, supersededPerDate, total }) => {
          const isRecent = view.recentEntities.has(entity);
          return (
            <div key={entity} className="river-row">
              <button
                type="button"
                className="river-lane-label"
                onClick={() => navigate(`/thread?entity=${encodeURIComponent(entity)}`)}
              >
                <span className={`dot${isRecent ? " dot-pulse" : ""}`} style={{ background: data.entity_colors[entity] ?? "#666" }} />
                <span className="river-lane-name">{entity}</span>
                <span className="muted small">{total}</span>
              </button>
              <div className="river-cells">
                {view.dates.map((d) => {
                  const v = perDate.get(d) ?? 0;
                  const sc = supersededPerDate.get(d) ?? 0;
                  const hasAny = v > 0 || sc > 0;
                  const cls = [
                    "river-cell",
                    `tier-${tier(v)}`,
                    sc > 0 ? "has-corrections" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <div
                      key={d}
                      className={cls}
                      onMouseEnter={(e) => setHover({ entity, date: d, count: v, superseded: sc, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => hasAny && onCellClick(entity, d)}
                      style={hasAny ? { cursor: "pointer" } : {}}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {view.laneRows.length === 0 && <div className="muted">No entities in this window.</div>}

      {hover && (hover.count > 0 || hover.superseded > 0) && (
        <div className="river-hover" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <span className="dot" style={{ background: data.entity_colors[hover.entity] ?? "#666" }} />
          <span className="river-hover-name">{hover.entity}</span>
          <span className="muted small">
            {hover.date}
            {hover.count > 0 && ` · ${hover.count} session${hover.count === 1 ? "" : "s"}`}
            {hover.superseded > 0 && ` · ${hover.superseded} corrected`}
          </span>
        </div>
      )}

      {cellDrawer && (
        <CellPicker
          state={cellDrawer}
          entityColor={data.entity_colors[cellDrawer.entity] ?? "#666"}
          onClose={() => setCellDrawer(null)}
          onPick={(sid) => { setCellDrawer(null); setSessionId(sid); }}
          onOpenThread={() => navigate(`/thread?entity=${encodeURIComponent(cellDrawer.entity)}`)}
        />
      )}

      {sessionId && (() => {
        const siblingList = cellDrawer
          ? cellDrawer.sessions
          : [...data.sessions].filter((s) => s.started_at !== null).sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
        const idx = siblingList.findIndex((s) => s.id === sessionId);
        const prevId = idx < siblingList.length - 1 ? siblingList[idx + 1]!.id : null;
        const nextId = idx > 0 ? siblingList[idx - 1]!.id : null;
        const s = data.sessions.find((x) => x.id === sessionId);
        const e = s?.entities[0];
        return (
          <SessionDrawer
            sessionId={sessionId}
            onClose={() => setSessionId(null)}
            onNavigate={setSessionId}
            prevSessionId={prevId}
            nextSessionId={nextId}
            entityColor={e ? data.entity_colors[e] : undefined}
          />
        );
      })()}
    </div>
  );
}

interface CellPickerProps {
  state: CellDrawerState;
  entityColor: string;
  onClose: () => void;
  onPick: (sessionId: string) => void;
  onOpenThread: () => void;
}

function CellPicker({ state, entityColor, onClose, onPick, onOpenThread }: CellPickerProps) {
  return (
    <Drawer
      onClose={onClose}
      ariaLabel={`Sessions on ${state.date}`}
      head={
        <>
          <span className="dot lg" style={{ background: entityColor }} />
          <h3 className="drawer-title">{state.entity}</h3>
          <span className="muted small">{state.date}</span>
        </>
      }
    >
      <p className="muted small">{state.sessions.length} sessions on this day. Pick one to inspect.</p>
      <div className="drawer-actions">
        <button type="button" className="btn btn-accent" onClick={onOpenThread}>Open thread</button>
      </div>
      <ul className="session-list">
        {state.sessions.map((s) => (
          <li key={s.id} className="session-row session-row-detail clickable" {...rowProps(() => onPick(s.id))}>
            <span className={`chip-inline status-${s.status}`}>{s.status}</span>
            <div className="session-row-main">
              <span className="session-label">{s.label}</span>
              <span className="session-meta">{s.summary}</span>
            </div>
            <span className="muted small mono">{relativeAge(s.started_at)}</span>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

function tier(v: number): 0 | 1 | 2 | 3 | 4 {
  if (v === 0) return 0;
  if (v === 1) return 1;
  if (v <= 3) return 2;
  if (v <= 6) return 3;
  return 4;
}
