/**
 * Format helpers. One canonical implementation per kind so a future
 * locale switch, sig-fig change, or pluralization library swap touches
 * one file instead of every render site.
 *
 *   import { fmt } from "../lib/format";
 *   fmt.count(1234)                // "1,234"
 *   fmt.plural(1, "topic")         // "1 topic"
 *   fmt.plural(3, "topic")         // "3 topics"
 *   fmt.plural(3, "child", "children")
 *   fmt.percent(0.382)             // "38%"
 *   fmt.shortDate("2026-04-12T…")  // "Apr 12, 2026"
 *   fmt.daysBetween(isoA, isoB)    // 7
 *
 * relativeAge lives in lib/dataset.ts and is re-exported here so all
 * temporal formatting can be imported from one place.
 */

export { relativeAge } from "./dataset.js";

export const fmt = {
  count(n: number): string {
    return n.toLocaleString();
  },

  /** "1 topic", "3 topics". Override the plural with the third argument. */
  plural(n: number, singular: string, pluralForm?: string): string {
    const word = n === 1 ? singular : (pluralForm ?? `${singular}s`);
    return `${fmt.count(n)} ${word}`;
  },

  /** Integer percent. Pass a 0-1 ratio (0.38 → "38%") or a pre-rounded value with the `raw` flag. */
  percent(value: number, opts?: { raw?: boolean }): string {
    const v = opts?.raw ? value : value * 100;
    return `${Math.round(v)}%`;
  },

  /** "Apr 12, 2026" — short month + day + year. Locale-aware. Returns "—" for invalid input. */
  shortDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "—";
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  },

  /** Floored whole-day difference (b - a). Negative if a is after b. */
  daysBetween(a: string | null | undefined, b: string | null | undefined): number {
    if (!a || !b) return 0;
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
    return Math.floor((tb - ta) / 86_400_000);
  },
};
