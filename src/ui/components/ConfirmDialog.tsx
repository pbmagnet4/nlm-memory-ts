/**
 * ConfirmDialog — renders the current confirm state. Mount once at app root.
 * Fire via `confirmAction` from lib/confirm.
 */

import { useEffect, useRef } from "react";
import { resolveConfirm, useConfirmState } from "../lib/confirm.js";

export function ConfirmDialog() {
  const s = useConfirmState();
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!s.open) return;
    confirmBtnRef.current?.focus();
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") resolveConfirm(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [s.open]);

  if (!s.open) return null;

  return (
    <>
      <div className="palette-backdrop" onClick={() => resolveConfirm(false)} />
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
      >
        <h3 id="confirm-title" className="confirm-title">{s.title}</h3>
        <p id="confirm-message" className="confirm-message">{s.message}</p>
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={() => resolveConfirm(false)}>
            {s.cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={`btn ${s.kind === "danger" ? "btn-danger" : "btn-accent"}`}
            onClick={() => resolveConfirm(true)}
          >
            {s.confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
