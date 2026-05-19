import { usePolledEndpoint, relativeTime } from "../lib/api.js";
import type { RecentMarker, RecentRead, RecentWrite } from "../lib/api.js";

const POLL_MS = 3000;

interface ReadsResponse { entries: RecentRead[] }
interface WritesResponse { writes: RecentWrite[] }
interface MarkersResponse { markers: RecentMarker[] }

export function LivePage() {
  const reads   = usePolledEndpoint<ReadsResponse>  ("/api/recall/recent?limit=50",        POLL_MS, { entries: [] });
  const writes  = usePolledEndpoint<WritesResponse> ("/api/live/recent-writes?limit=50",  POLL_MS, { writes:  [] });
  const markers = usePolledEndpoint<MarkersResponse>("/api/live/recent-markers?limit=50", POLL_MS, { markers: [] });

  return (
    <div className="live-board">
      <Column title="Reads" count={reads.entries.length}>
        {reads.entries.length === 0 ? (
          <div className="live-empty">no recent recall</div>
        ) : (
          reads.entries.map((r, i) => (
            <div className="live-row" key={`${r.ts}-${i}`}>
              <span className="live-tag">{r.source}</span>
              <span className="label">{r.query ?? "(no query)"}</span>
              <div className="body">{r.mode} · {r.nResults} hit{r.nResults === 1 ? "" : "s"}</div>
              <div className="meta">{relativeTime(r.ts)}</div>
            </div>
          ))
        )}
      </Column>

      <Column title="Writes" count={writes.writes.length}>
        {writes.writes.length === 0 ? (
          <div className="live-empty">no recent writes</div>
        ) : (
          writes.writes.map((w) => (
            <div className="live-row" key={w.id}>
              <span className="live-tag">{w.runtime.split("/")[0]}</span>
              <span className="label">{w.label}</span>
              <div className="body">{w.summary}</div>
              <div className="meta">{relativeTime(w.createdAt)} · {w.id}</div>
            </div>
          ))
        )}
      </Column>

      <Column title="Decisions" count={markers.markers.length}>
        {markers.markers.length === 0 ? (
          <div className="live-empty">no recent decisions</div>
        ) : (
          markers.markers.map((m, i) => (
            <div className="live-row" key={`${m.sessionId}-${i}`}>
              <span className="live-tag" data-kind={m.kind}>{m.kind}</span>
              <span className="label">{m.text}</span>
              <div className="body">{m.label}</div>
              <div className="meta">{relativeTime(m.createdAt)}</div>
            </div>
          ))
        )}
      </Column>
    </div>
  );
}

function Column({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="live-col">
      <header className="live-col-head">
        <span className="live-col-title">{title}</span>
        <span className="live-col-count">{count}</span>
      </header>
      <div className="live-col-body">{children}</div>
    </section>
  );
}
