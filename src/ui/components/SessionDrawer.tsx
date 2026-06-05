// Note: SessionDrawer doesn't use the canonical <Drawer> wrapper. Its
// requirements diverge: arrow-key prev/next nav, supersede palette with
// nested Escape gating, kebab action menu, and a skeleton rendered
// outside .drawer-body. Refactoring through Drawer would need too many
// escape hatches. New drawers should use Drawer + Pagination.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SessionDrawerSkeleton } from "./Skeleton.js";
import { SupersedePalette } from "./SupersedePalette.js";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  // Reset transient sub-UI state on every session change so a palette opened
  // for sess_a doesn't leak into sess_b when the user navigates via the
  // arrow keys mid-flow.
  useEffect(() => {
    setPaletteOpen(false);
    setMenuOpen(false);
  }, [sessionId]);

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
  }, [sessionId, reloadTick]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // When the supersede palette is open, it owns keyboard focus and Esc.
      // Skip handling here so a single Esc only closes the palette, not the
      // drawer underneath. SupersedePalette also stopPropagation()s but we
      // belt-and-suspenders against missed events from native dispatch order.
      if (paletteOpen) return;
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowLeft" && prevSessionId != null && onNavigate) onNavigate(prevSessionId);
      if (e.key === "ArrowRight" && nextSessionId != null && onNavigate) onNavigate(nextSessionId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onNavigate, prevSessionId, nextSessionId, paletteOpen]);

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
          <div className="drawer-menu" ref={menuRef}>
            <button
              type="button"
              className="drawer-menu-trigger"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Session actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={!session}
            >
              ⋯
            </button>
            {menuOpen && (
              <ul className="drawer-menu-list" role="menu">
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="drawer-menu-item"
                    disabled={!session}
                    onClick={() => {
                      setMenuOpen(false);
                      setPaletteOpen(true);
                    }}
                  >
                    Mark superseded by…
                  </button>
                </li>
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="drawer-menu-item"
                    onClick={() => {
                      void navigator.clipboard?.writeText(sessionId);
                      setMenuOpen(false);
                    }}
                  >
                    Copy session ID
                  </button>
                </li>
              </ul>
            )}
          </div>
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
                <h4 className="drawer-section">Topics</h4>
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
      {paletteOpen && session && (
        <SupersedePalette
          predecessorId={session.id}
          predecessorLabel={session.label || session.id}
          onClose={() => setPaletteOpen(false)}
          onMarked={(successorId) => {
            setPaletteOpen(false);
            // Optimistic: paint the supersedence banner immediately so the user
            // sees their change before the canonical refresh round-trips. The
            // reload still fires so any server-side mutations (e.g. status
            // recompute) reconcile within one tick.
            setSession((prev) =>
              prev ? { ...prev, status: "superseded", supersededBy: successorId } : prev,
            );
            setReloadTick((t) => t + 1);
          }}
        />
      )}
    </>
  );
}
