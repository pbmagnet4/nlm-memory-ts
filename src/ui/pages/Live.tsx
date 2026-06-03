import { useEffect, useRef, useState } from "react";
import { usePolledEndpoint, relativeTime } from "../lib/api.js";
import type { PolledResult, RecentMarker, RecentRead, RecentWrite } from "../lib/api.js";
import { SessionDrawer } from "../components/SessionDrawer.js";

const POLL_MS = 3000;
/** Past this many ms with no successful fetch, the board is treated as stale. */
const STALE_MS = POLL_MS * 3;

interface ReadsResponse { entries: RecentRead[] }
interface WritesResponse { writes: RecentWrite[] }
interface MarkersResponse { markers: RecentMarker[] }

/**
 * Tracks which row keys are newly arrived so they can flash once. The first
 * populated render seeds the seen-set silently — only genuinely new rows
 * after that are reported fresh, for ~1.2s each.
 */
function useFreshKeys(keys: string[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const signature = keys.join("|");

  useEffect(() => {
    if (keys.length === 0) return;
    if (seen.current === null) {
      seen.current = new Set(keys);
      return;
    }
    const added = keys.filter((k) => !seen.current!.has(k));
    for (const k of keys) seen.current!.add(k);
    if (added.length === 0) return;
    setFresh((prev) => new Set([...prev, ...added]));
    const t = setTimeout(() => {
      setFresh((prev) => {
        const next = new Set(prev);
        for (const k of added) next.delete(k);
        return next;
      });
    }, 1200);
    return () => clearTimeout(t);
    // signature captures the ordered key list; keys identity is unstable.
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  return fresh;
}

export function LivePage() {
  const reads = usePolledEndpoint<ReadsResponse>("/api/recall/recent?limit=50", POLL_MS, { entries: [] });
  const writes = usePolledEndpoint<WritesResponse>("/api/live/recent-writes?limit=50", POLL_MS, { writes: [] });
  const markers = usePolledEndpoint<MarkersResponse>("/api/live/recent-markers?limit=50", POLL_MS, { markers: [] });

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hoveredSid, setHoveredSid] = useState<string | null>(null);
  // Returned setter clears only if the row leaving is the one currently
  // hovered. Prevents a leave-event from a stale row clobbering a fresh
  // hover when the user moves quickly between rows.
  const setHover = (sid: string) => (entering: boolean) => {
    if (entering) setHoveredSid(sid);
    else setHoveredSid((prev) => (prev === sid ? null : prev));
  };

  const readKeys = reads.data.entries.map((r) => `${r.ts}|${r.source}|${r.query ?? ""}`);
  const writeKeys = writes.data.writes.map((w) => w.id);
  const markerKeys = markers.data.markers.map((m) => `${m.sessionId}|${m.kind}|${m.text}`);
  const freshReads = useFreshKeys(readKeys);
  const freshWrites = useFreshKeys(writeKeys);
  const freshMarkers = useFreshKeys(markerKeys);

  return (
    <div className="live-page">
      <ConnectionBar reads={reads} writes={writes} markers={markers} />

      <div className="live-board">
        <Column
          title="Reads"
          count={reads.data.entries.length}
          loading={reads.loading}
          emptyLabel="no recent recall"
        >
          {reads.data.entries.map((r, i) => {
            const key = readKeys[i]!;
            return (
              <div className={`live-row${freshReads.has(key) ? " is-new" : ""}`} key={key}>
                <span className="live-tag" title={r.runtime ? `via ${r.source}` : undefined}>{r.runtime ?? r.source}</span>
                <span className="label">{r.query ?? "(no query)"}</span>
                <div className="body">{r.mode} · {r.nResults} hit{r.nResults === 1 ? "" : "s"}</div>
                <div className="meta">{relativeTime(r.ts)}</div>
              </div>
            );
          })}
        </Column>

        <Column
          title="Writes"
          count={writes.data.writes.length}
          loading={writes.loading}
          emptyLabel="no recent writes"
        >
          {writes.data.writes.map((w) => (
            <Row
              key={w.id}
              fresh={freshWrites.has(w.id)}
              related={hoveredSid !== null && hoveredSid === w.id}
              onOpen={() => setSessionId(w.id)}
              onHover={setHover(w.id)}
            >
              <span className="live-tag">{w.runtime.split("/")[0]}</span>
              <span className="label">{w.label}</span>
              <div className="body">{w.summary}</div>
              {w.entities.length > 0 && (
                <div className="entity-chips entity-chips-row">
                  {w.entities.slice(0, 3).map((e) => (
                    <span key={e} className="chip-inline" data-kind="entity">{e}</span>
                  ))}
                  {w.entities.length > 3 && (
                    <span className="muted small">+{w.entities.length - 3}</span>
                  )}
                </div>
              )}
              <div className="meta">{relativeTime(w.createdAt)} · {w.id}</div>
            </Row>
          ))}
        </Column>

        <Column
          title="Markers"
          count={markers.data.markers.length}
          loading={markers.loading}
          emptyLabel="no recent markers"
        >
          {markers.data.markers.map((m, i) => {
            const key = markerKeys[i]!;
            return (
              <Row
                key={key}
                fresh={freshMarkers.has(key)}
                related={hoveredSid !== null && hoveredSid === m.sessionId}
                onOpen={() => setSessionId(m.sessionId)}
                onHover={setHover(m.sessionId)}
              >
                <span className="live-tag" data-kind={m.kind}>{m.kind}</span>
                <span className="label">{m.text}</span>
                <div className="body">{m.label}</div>
                <div className="meta">{relativeTime(m.createdAt)}</div>
              </Row>
            );
          })}
        </Column>
      </div>

      {sessionId && (
        <SessionDrawer sessionId={sessionId} onClose={() => setSessionId(null)} />
      )}
    </div>
  );
}

function ConnectionBar({
  reads,
  writes,
  markers,
}: {
  reads: PolledResult<unknown>;
  writes: PolledResult<unknown>;
  markers: PolledResult<unknown>;
}) {
  const all = [reads, writes, markers];
  const loading = all.every((p) => p.loading);
  const stamps = all.map((p) => p.lastUpdated).filter((t): t is number => t !== null);
  const freshest = stamps.length > 0 ? Math.max(...stamps) : null;
  const anyError = all.some((p) => p.error !== null);
  const stale = freshest !== null && Date.now() - freshest > STALE_MS;

  let status: "connecting" | "live" | "reconnecting";
  if (loading) status = "connecting";
  else if (stale || anyError) status = "reconnecting";
  else status = "live";

  const label =
    status === "connecting" ? "Connecting…"
    : status === "reconnecting" ? "Reconnecting…"
    : "Live";

  return (
    <div className="live-status">
      <span className={`live-status-dot live-status-${status}`} aria-hidden="true" />
      <span className="live-status-label">{label}</span>
      {freshest !== null && (
        <span className="muted small">
          updated {relativeTime(new Date(freshest).toISOString())}
        </span>
      )}
      <span className="header-spacer" />
      <span className="muted small mono">polling every {POLL_MS / 1000}s</span>
    </div>
  );
}

function Column({
  title,
  count,
  loading,
  emptyLabel,
  children,
}: {
  title: string;
  count: number;
  loading: boolean;
  emptyLabel: string;
  children: React.ReactNode;
}) {
  const isEmpty = count === 0;
  return (
    <section className="live-col">
      <header className="live-col-head">
        <span className="live-col-title">{title}</span>
        <span className="live-col-count">{count}</span>
      </header>
      <div className="live-col-body">
        {isEmpty
          ? <div className="live-empty">{loading ? "loading…" : emptyLabel}</div>
          : children}
      </div>
    </section>
  );
}

function Row({
  fresh,
  related,
  onOpen,
  onHover,
  children,
}: {
  fresh: boolean;
  related?: boolean;
  onOpen: () => void;
  onHover?: (entering: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`live-row clickable${fresh ? " is-new" : ""}${related ? " is-related" : ""}`}
      onClick={onOpen}
      onMouseEnter={onHover ? () => onHover(true) : undefined}
      onMouseLeave={onHover ? () => onHover(false) : undefined}
      onFocus={onHover ? () => onHover(true) : undefined}
      onBlur={onHover ? () => onHover(false) : undefined}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
      }}
    >
      {children}
    </div>
  );
}
