/**
 * Canonical slide-in drawer. Handles backdrop click + Escape + close button.
 * Pass `blockEsc` when an inner UI (palette, picker, confirm) owns Escape.
 * Header is a slot — caller composes dot/title/badges; close button is automatic.
 */

import { useEffect, useRef, type ReactNode } from "react";

interface DrawerProps {
  onClose: () => void;
  ariaLabel: string;
  head: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  blockEsc?: boolean;
  className?: string;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Drawer({ onClose, ariaLabel, head, children, footer, blockEsc, className }: DrawerProps) {
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape" && !blockEsc) onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose, blockEsc]);

  // Focus management. Capture the element that had focus before the drawer
  // opened so we can hand control back to it on close. Move focus into the
  // drawer on mount — first non-close focusable, falling back to the close
  // button when the drawer is content-only.
  useEffect(() => {
    const previous = (document.activeElement instanceof HTMLElement) ? document.activeElement : null;
    const focusables = Array.from(
      asideRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    );
    const target = focusables.find((el) => !el.classList.contains("drawer-close")) ?? focusables[0];
    target?.focus();
    return () => {
      previous?.focus();
    };
  }, []);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside
        ref={asideRef}
        className={`session-drawer${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <header className="drawer-head">
          {head}
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer}
      </aside>
    </>
  );
}
