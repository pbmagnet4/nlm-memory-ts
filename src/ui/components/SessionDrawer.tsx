/**
 * SessionDrawer — right-side detail panel for a single session.
 * Fetches /api/session/:id on open. Shared between Thread (entity timeline)
 * and Pulse (Recent sessions) — and ready for any future caller.
 */

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
}

interface SessionDrawerProps {
  sessionId: string;
  onClose: () => void;
  /** Optional dot color (Thread passes the entity color). */
  entityColor?: string;
}

export function SessionDrawer({ sessionId, onClose, entityColor }: SessionDrawerProps) {
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
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [sessionId]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="session-drawer" role="dialog" aria-modal="true">
        <header className="drawer-head">
          {entityColor && <span className="dot" style={{ background: entityColor }} />}
          <h3 className="drawer-title">{session?.label ?? sessionId}</h3>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        {error && <div className="muted error drawer-body">{error}</div>}
        {!session && !error && <SessionDrawerSkeleton />}
        {session && (
          <div className="drawer-body">
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
            {session.summary && (
              <>
                <h4 className="drawer-section">Summary</h4>
                <p className="drawer-paragraph">{session.summary}</p>
              </>
            )}
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
