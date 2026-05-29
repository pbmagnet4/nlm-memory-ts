import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SessionDrawerSkeleton } from "./Skeleton.js";

interface SessionDetail {
  id: string;
  label: string;
  summary: string;
  body: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMin: number | null;
  runtime: string;
  entities: string[];
  decisions: string[];
  open: string[];
  supersededBy: string | null;
  supersedes: string[];
}

interface SessionDrawerProps {
  sessionId: string;
  onClose: () => void;
  entityColor?: string;
  onNavigate?: (id: string) => void;
  prevSessionId?: string | null;
  nextSessionId?: string | null;
}

export function SessionDrawer({ sessionId, onClose, entityColor, onNavigate, prevSessionId, nextSessionId }: SessionDrawerProps) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSession(null);
    setError(null);
    fetch(`/api/session/${encodeURIComponent(sessionId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const raw = (await r.json()) as Record<string, unknown>;
        setSession({
          id: String(raw["id"] ?? sessionId),
          label: String(raw["label"] ?? ""),
          summary: String(raw["summary"] ?? ""),
          body: String(raw["body"] ?? ""),
          status: String(raw["status"] ?? "closed"),
          startedAt: typeof raw["startedAt"] === "string" ? (raw["startedAt"] as string) : null,
          endedAt: typeof raw["endedAt"] === "string" ? (raw["endedAt"] as string) : null,
          durationMin: typeof raw["durationMin"] === "number" ? (raw["durationMin"] as number) : null,
          runtime: String(raw["runtime"] ?? ""),
          entities: Array.isArray(raw["entities"]) ? (raw["entities"] as string[]) : [],
          decisions: Array.isArray(raw["decisions"]) ? (raw["decisions"] as string[]) : [],
          open: Array.isArray(raw["open"]) ? (raw["open"] as string[]) : [],
          supersededBy: typeof raw["supersededBy"] === "string" ? (raw["supersededBy"] as string) : null,
          supersedes: Array.isArray(raw["supersedes"]) ? (raw["supersedes"] as string[]) : [],
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [sessionId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowLeft" && prevSessionId != null && onNavigate) onNavigate(prevSessionId);
      if (e.key === "ArrowRight" && nextSessionId != null && onNavigate) onNavigate(nextSessionId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onNavigate, prevSessionId, nextSessionId]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="session-drawer" role="dialog" aria-modal="true">
        <header className="drawer-head">
          {entityColor && <span className="dot" style={{ background: entityColor }} />}
          <h3 className="drawer-title">{session?.label ?? sessionId}</h3>
          {(prevSessionId != null || nextSessionId != null) && onNavigate && (
            <div className="drawer-nav">
              <button
                type="button"
                className="drawer-nav-btn"
                disabled={prevSessionId == null}
                onClick={() => prevSessionId && onNavigate(prevSessionId)}
                aria-label="Previous session"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
              </button>
              <button
                type="button"
                className="drawer-nav-btn"
                disabled={nextSessionId == null}
                onClick={() => nextSessionId && onNavigate(nextSessionId)}
                aria-label="Next session"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
              </button>
            </div>
          )}
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        {error && <div className="muted error drawer-body">{error}</div>}
        {!session && !error && <SessionDrawerSkeleton />}
        {session && (
          <div className="drawer-body">
            {session.supersededBy && (
              <div className="supersedence-banner supersedence-banner--superseded">
                <span className="supersedence-label">Superseded by</span>
                {onNavigate ? (
                  <button
                    type="button"
                    className="supersedence-link"
                    onClick={() => onNavigate(session.supersededBy!)}
                  >
                    {session.supersededBy}
                  </button>
                ) : (
                  <span className="supersedence-id mono small">{session.supersededBy}</span>
                )}
              </div>
            )}
            {session.supersedes.length > 0 && (
              <div className="supersedence-banner supersedence-banner--supersedes">
                <span className="supersedence-label">Supersedes</span>
                <span className="supersedence-ids">
                  {session.supersedes.map((sid) => (
                    onNavigate ? (
                      <button
                        key={sid}
                        type="button"
                        className="supersedence-link"
                        onClick={() => onNavigate(sid)}
                      >
                        {sid}
                      </button>
                    ) : (
                      <span key={sid} className="supersedence-id mono small">{sid}</span>
                    )
                  ))}
                </span>
              </div>
            )}
            {session.summary && (
              <>
                <h4 className="drawer-section">Summary</h4>
                <p className="drawer-paragraph">{session.summary}</p>
              </>
            )}
            {session.decisions.length > 0 && (
              <>
                <h4 className="drawer-section">Decisions</h4>
                <ul className="drawer-list">
                  {session.decisions.map((d, i) => <li key={i}><span className="live-tag" data-kind="decision">decision</span> {d}</li>)}
                </ul>
              </>
            )}
            {session.open.length > 0 && (
              <>
                <h4 className="drawer-section">Open questions</h4>
                <ul className="drawer-list">
                  {session.open.map((q, i) => <li key={i}><span className="live-tag" data-kind="open">open</span> {q}</li>)}
                </ul>
              </>
            )}
            {session.entities.length > 0 && (
              <>
                <h4 className="drawer-section">Entities</h4>
                <div className="entity-chips">
                  {session.entities.map((e) => (
                    <Link key={e} to={`/thread?entity=${encodeURIComponent(e)}`} className="chip" onClick={onClose}>{e}</Link>
                  ))}
                </div>
              </>
            )}
            <dl className="kv-list">
              <dt className="kv-label">Status</dt>
              <dd className="kv-value"><span className={`chip-inline status-${session.status}`}>{session.status}</span></dd>
              <dt className="kv-label">Started</dt>
              <dd className="kv-value mono small">{session.startedAt ?? "—"}</dd>
              <dt className="kv-label">Duration</dt>
              <dd className="kv-value">{session.durationMin ?? "—"} min</dd>
              <dt className="kv-label">Runtime</dt>
              <dd className="kv-value mono small">{session.runtime}</dd>
              <dt className="kv-label">Session ID</dt>
              <dd className="kv-value mono small">{session.id}</dd>
            </dl>
            {session.body && (
              <>
                <h4 className="drawer-section">Transcript excerpt</h4>
                <pre className="drawer-body-text">{session.body.slice(0, 3000)}{session.body.length > 3000 ? "\n\n[…truncated]" : ""}</pre>
              </>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
