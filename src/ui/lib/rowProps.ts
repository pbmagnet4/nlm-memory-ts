/**
 * Spread on any list row that should behave as a button: role/tabIndex,
 * onClick, and Enter/Space keyboard activation. Cuts the boilerplate
 * `role="button" tabIndex={0} onClick onKeyDown` triple from every callsite.
 */

import type { KeyboardEvent, MouseEvent } from "react";

interface RowProps {
  role: "button";
  tabIndex: 0;
  onClick: (e: MouseEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

export function rowProps(onActivate: () => void): RowProps {
  return {
    role: "button",
    tabIndex: 0,
    onClick: () => onActivate(),
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
  };
}
