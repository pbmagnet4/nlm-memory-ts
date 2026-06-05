/**
 * ToastHost — renders the current toast queue. Mount once at app root.
 * Fire toasts via the imperative `toast.*` API from lib/toast.
 */

import { toast, useToasts } from "../lib/toast.js";

export function ToastHost() {
  const items = useToasts();
  if (items.length === 0) return null;
  return (
    <div className="toast-host">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role={t.kind === "error" ? "alert" : "status"}
          aria-live={t.kind === "error" ? "assertive" : "polite"}
        >
          <span className="toast-message">{t.message}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => toast.dismiss(t.id)}
            aria-label="Dismiss"
          >×</button>
        </div>
      ))}
    </div>
  );
}
