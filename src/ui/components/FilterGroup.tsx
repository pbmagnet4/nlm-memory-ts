/**
 * FilterGroup: semantic wrapper for a set of toggle filters (severity, sort,
 * bucket, etc.). Always pair with FilterChip children. Pass `label` so screen
 * readers announce the group's purpose.
 *
 * FilterChip: a single toggle. `active` controls visual state and aria-pressed.
 * Optional `count` shows a trailing " · N". Disabled chips can't be toggled.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

interface FilterGroupProps {
  label: string;
  children: ReactNode;
  className?: string;
}

export function FilterGroup({ label, children, className }: FilterGroupProps) {
  return (
    <div
      className={`filter-group${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  );
}

type FilterChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "aria-pressed" | "type"> & {
  active: boolean;
  count?: number;
};

export function FilterChip({ active, count, children, ...rest }: FilterChipProps) {
  return (
    <button
      type="button"
      className={`chip${active ? " active" : ""}`}
      aria-pressed={active}
      {...rest}
    >
      {children}{count !== undefined ? ` · ${count}` : ""}
    </button>
  );
}
