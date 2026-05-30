/**
 * UpdateBanner — passive footer notice in the SideNav. Polls
 * /api/update-status (daily-cached server-side) and renders nothing unless
 * the running daemon is strictly behind the latest npm-published version.
 *
 * Action surface is intentionally narrow: a Copy button that puts the
 * exact install command on the clipboard. No one-click install — npm
 * itself doesn't auto-update, and we don't know whether the user
 * installed via npm/pnpm/volta/fnm/Homebrew. Following npm's pattern of
 * "here's the command, you run it" is the right humble v1.
 */

import { useEffect, useState } from "react";

interface UpdateStatus {
  current: string;
  latest: string | null;
  behind: boolean;
  checkedAt: string;
  disabled?: "user-opt-out" | "unknown-error";
}

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const INSTALL_CMD = "npm i -g nlm-memory@latest";

export function UpdateBanner({ collapsed }: { collapsed: boolean }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [dismissedFor, setDismissedFor] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem("nlm.update.dismissed") ?? null;
  });

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const r = await fetch("/api/update-status");
        if (!r.ok) return;
        const next = (await r.json()) as UpdateStatus;
        if (!cancelled) setStatus(next);
      } catch {
        // Network errors are silent — the daemon may be restarting and
        // the next poll will pick up the result.
      }
    }
    void check();
    const id = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!status || !status.behind || !status.latest) return null;
  if (dismissedFor === status.latest) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(INSTALL_CMD);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  function handleDismiss() {
    if (!status?.latest) return;
    window.localStorage.setItem("nlm.update.dismissed", status.latest);
    setDismissedFor(status.latest);
  }

  if (collapsed) {
    return (
      <button
        type="button"
        className="update-banner update-banner--collapsed"
        onClick={handleCopy}
        title={`Update available — ${status.current} → ${status.latest}. Click to copy install command.`}
        aria-label={`Update ${status.latest} available — click to copy install command`}
      >
        <span className="update-dot" aria-hidden="true">●</span>
      </button>
    );
  }

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <div className="update-banner-head">
        <span className="update-banner-version mono small">
          {status.current} → {status.latest}
        </span>
        <button
          type="button"
          className="update-banner-dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss this update notice"
          title="Hide until the next release"
        >
          ×
        </button>
      </div>
      <p className="update-banner-body small">
        New version available on npm.
      </p>
      <div className="update-banner-cmd mono small" aria-label="Install command">
        {INSTALL_CMD}
      </div>
      <div className="update-banner-actions">
        <button
          type="button"
          className="update-banner-copy"
          onClick={handleCopy}
        >
          {copied ? "copied ✓" : "copy command"}
        </button>
        <a
          className="update-banner-link small"
          href={`https://github.com/pbmagnet4/nlm-memory-ts/releases/tag/v${status.latest}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          release notes
        </a>
      </div>
    </div>
  );
}
