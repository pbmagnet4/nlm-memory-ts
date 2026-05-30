import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { UpdateBanner } from "./UpdateBanner.js";

const STORAGE_KEY = "nlm.sidenav.collapsed";

interface NavItem {
  to: string;
  label: string;
  icon: JSX.Element;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/live",   label: "Live",   icon: liveIcon() },
  { to: "/pulse",  label: "Pulse",  icon: pulseIcon() },
  { to: "/river",  label: "River",  icon: riverIcon() },
  { to: "/thread", label: "Thread", icon: threadIcon() },
  { to: "/search", label: "Search", icon: searchIcon() },
  { to: "/recall", label: "Recall", icon: recallIcon() },
  { to: "/settings", label: "Settings", icon: settingsIcon() },
];

export function SideNav() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });

  useEffect(() => {
    document.body.style.setProperty("--sidenav-w", collapsed ? "52px" : "180px");
    window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  return (
    <nav className={`sidenav${collapsed ? " collapsed" : ""}`} aria-label="Primary navigation">
      <div className="sidenav-header">
        <span className="sidenav-wordmark">NLM</span>
        <button
          className="sidenav-toggle"
          aria-label="Toggle sidebar"
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? chevronRight() : chevronLeft()}
        </button>
      </div>

      <div className="sidenav-items">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `sidenav-item${isActive ? " active" : ""}`}
            data-label={item.label}
          >
            <span className="item-icon">{item.icon}</span>
            <span className="item-label">{item.label}</span>
          </NavLink>
        ))}
      </div>

      <div className="sidenav-footer">
        <UpdateBanner collapsed={collapsed} />
        <NavLink to="/settings/data" className="sidenav-item sidenav-data" data-label="Data">
          <span className="item-icon">{dataIcon()}</span>
          <span className="item-label">Data</span>
        </NavLink>
      </div>
    </nav>
  );
}

// ── icons — extracted verbatim from Astro SideNav for visual parity ──────

function svg(children: JSX.Element, size = 16) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function liveIcon() {
  // green-dot broadcast — distinct from pulse so /live reads as its own thing
  return svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 00-14 0M22 12a10 10 0 00-20 0" />
    </>,
  );
}

function pulseIcon() {
  return svg(<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />);
}

function riverIcon() {
  return svg(<path d="M2 12c1.5-3 3-4.5 4.5-4.5S9 9 10.5 12s3 4.5 4.5 4.5S18 15 19.5 12 21 7.5 22 7.5" />);
}

function threadIcon() {
  return svg(
    <>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 01-9 9" />
    </>,
  );
}

function searchIcon() {
  return svg(
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
  );
}

function recallIcon() {
  // bar-chart — observability / adoption telemetry
  return svg(
    <>
      <line x1="6" y1="20" x2="6" y2="13" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="18" y1="20" x2="18" y2="9" />
    </>,
  );
}

function settingsIcon() {
  return svg(
    <>
      <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <circle cx="12" cy="12" r="3" />
    </>,
  );
}

function dataIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.657-4.03 3-9 3S3 13.657 3 12" />
      <path d="M3 5v14c0 1.657 4.03 3 9 3s9-1.343 9-3V5" />
    </svg>
  );
}

function chevronLeft() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function chevronRight() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
