/**
 * Confirmation dialog — imperative API. Mirrors browser `confirm()` so
 * existing call sites translate directly:
 *
 *   // before
 *   if (!confirm("Delete X?")) return;
 *   await deleteX();
 *
 *   // after
 *   if (!(await confirmAction({ title: "Delete X?", message: "...", kind: "danger" }))) return;
 *   await deleteX();
 *
 * Mount <ConfirmDialog /> once at the app root. One outstanding at a time;
 * calling while one is open auto-resolves the prior with `false`.
 */

import { useEffect, useState } from "react";

export type ConfirmKind = "default" | "danger";

export interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  kind: ConfirmKind;
}

const initial: ConfirmState = {
  open: false,
  title: "",
  message: "",
  confirmLabel: "Confirm",
  cancelLabel: "Cancel",
  kind: "default",
};

let state: ConfirmState = initial;
let resolver: ((value: boolean) => void) | null = null;
const listeners = new Set<(s: ConfirmState) => void>();

function emit(): void {
  for (const l of listeners) l(state);
}

export function confirmAction(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  kind?: ConfirmKind;
}): Promise<boolean> {
  // Auto-resolve any outstanding confirm with false so the next one can take
  // the slot. Belt-and-suspenders against runaway clicks.
  if (resolver) resolver(false);

  return new Promise<boolean>((resolve) => {
    resolver = resolve;
    state = {
      open: true,
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "Confirm",
      cancelLabel: opts.cancelLabel ?? "Cancel",
      kind: opts.kind ?? "default",
    };
    emit();
  });
}

export function resolveConfirm(value: boolean): void {
  if (resolver) {
    resolver(value);
    resolver = null;
  }
  state = { ...state, open: false };
  emit();
}

export function useConfirmState(): ConfirmState {
  const [snapshot, setSnapshot] = useState<ConfirmState>(state);
  useEffect(() => {
    const l = (next: ConfirmState) => setSnapshot(next);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return snapshot;
}
