/**
 * Tooltip — anchored hint that appears on hover or keyboard focus of its
 * single child. Use for icon buttons, truncated labels, or any UI where
 * the visible affordance can't carry the full meaning.
 *
 *   <Tooltip text="Snooze 30 days"><button>30d</button></Tooltip>
 *
 * For data-tracking tooltips that follow the mouse (e.g. River cells)
 * keep the bespoke implementation — that's a different shape and doesn't
 * belong here.
 */

import type { ReactNode } from "react";

interface TooltipProps {
  text: string;
  children: ReactNode;
  /** Side of the anchor the tooltip appears on. Default `top`. */
  placement?: "top" | "bottom";
}

export function Tooltip({ text, children, placement = "top" }: TooltipProps) {
  return (
    <span className={`tooltip-anchor tooltip-${placement}`}>
      {children}
      <span className="tooltip" role="tooltip">{text}</span>
    </span>
  );
}
