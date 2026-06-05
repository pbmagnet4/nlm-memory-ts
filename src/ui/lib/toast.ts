/**
 * Toast — fire-and-forget action feedback. Module-level state with a tiny
 * pub/sub so any callsite can fire a toast without a Provider or hook:
 *
 *   import { toast } from "../lib/toast";
 *   toast.success("Snoozed for 7 days");
 *   toast.error("Failed to save: " + err.message);
 *
 * Mount <ToastHost /> once at the app root. Auto-dismiss; errors stick
 * around longer than info/success because they need to be read.
 */

import { useEffect, useState } from "react";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
}

const listeners = new Set<(toasts: ToastItem[]) => void>();
let items: ToastItem[] = [];

function emit(): void {
  for (const l of listeners) l(items);
}

function fire(kind: ToastKind, message: string, durationMs?: number): string {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  items = [...items, { id, kind, message }];
  emit();
  const ms = durationMs ?? (kind === "error" ? 8000 : 4000);
  setTimeout(() => dismiss(id), ms);
  return id;
}

function dismiss(id: string): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (message: string, durationMs?: number) => fire("success", message, durationMs),
  error: (message: string, durationMs?: number) => fire("error", message, durationMs),
  info: (message: string, durationMs?: number) => fire("info", message, durationMs),
  dismiss,
};

export function useToasts(): ToastItem[] {
  const [snapshot, setSnapshot] = useState<ToastItem[]>(items);
  useEffect(() => {
    const l = (next: ToastItem[]) => setSnapshot(next);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return snapshot;
}
