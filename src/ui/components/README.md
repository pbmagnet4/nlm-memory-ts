# UI components

Canonical components for the NLM UI. Reach for these before writing new JSX or CSS. If a pattern is repeated three times across pages, it belongs here.

## Inventory

| Component | Purpose | When to use |
|---|---|---|
| `Drawer` | Right-anchored slide-in panel | All side-drawer UI |
| `Pagination` | Per-page select + range + nav chips | Any paginated list |
| `FilterGroup` / `FilterChip` | Toggle filter set | Severity/sort/bucket selectors |
| `Toast` (`ToastHost`) | Action feedback queue | Mounted once at app root; fire via `toast.*` API |
| `Tooltip` | Anchored hint on hover/focus | Icon buttons, status dots, truncated labels |
| `ConfirmDialog` | Imperative confirm modal | Mounted once at app root; fire via `confirmAction()` |
| `SessionDrawer` | Session detail drawer | Anywhere a session id is the subject |
| `SupersedePalette` | Centered command palette | Mark-superseded action |
| `MarkerActionMenu` | Inline action popover on a marker | Marker-row menus |
| `PromoteOpenButton` | Inline edit/promote form | Open-question rows |
| `UpdateBanner` | App-update notice | Daemon update detection |
| `SideNav` | Primary nav rail | App shell |
| `Skeleton` | Loading placeholders | Page-level loading states |

## Canonical patterns

### Drawer

Always use `<Drawer>` for any right-anchored slide-in. It handles backdrop click, Escape, focus container, the close button, and the `.drawer-head` / `.drawer-body` structure. Pagination goes in the `footer` slot (sticky outside the body).

```tsx
<Drawer
  onClose={onClose}
  ariaLabel="Runtime: claude-code/1.0"
  head={<><span className="dot lg" style={{ background: color }} /><h3 className="drawer-title">{title}</h3><span className="chip-inline status-active">active</span></>}
  footer={<Pagination page={p} pageSize={ps} total={total} onPageChange={setP} onPageSizeChange={setPs} />}
  blockEsc={mergeSource !== null}
>
  {/* body */}
</Drawer>
```

**Focus management:** On open, focus moves to the first non-close focusable element in the drawer (e.g., a search input or primary action). On close, focus returns to the element that had focus before the drawer opened. This is automatic — no consumer code required.

**Exemption:** `SessionDrawer` doesn't use `<Drawer>`. It has bespoke needs: arrow-key prev/next navigation, supersede palette with nested Escape gating, kebab action menu, skeleton rendered outside `.drawer-body`. New drawers should never be exempt — if the requirements diverge, extend `<Drawer>` instead.

### Pagination

Single source for paginators. Renders nothing when `total === 0`.

```tsx
<Pagination
  page={currentPage}
  pageSize={pageSize}
  total={items.length}
  onPageChange={setPage}
  onPageSizeChange={setPageSize}
/>
```

Default page sizes are `[10, 25, 50]`. Override via `pageSizes` only when domain demands it.

### Clickable rows

Convention (not a component yet — extracted when a hook lands):

```tsx
<li
  className="session-row clickable"
  role="button"
  tabIndex={0}
  onClick={() => onPick(id)}
  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(id); } }}
>
```

Always include the `clickable` class — CSS depends on it for `cursor: pointer`, hover background, and the accent label tint.

### Row states

Every interactive row is a small state machine. States layer in this order:

| State | How to mark | Visual |
|---|---|---|
| Idle | base classes | — |
| Hover | `:hover` (mouse) | bg one surface up + label tints to accent |
| Focus | `:focus-visible` (keyboard) | 1px accent outline, offset -1px |
| Selected | add `is-selected` class | surface-2 bg + 2px accent left-border (or outline in pickers) |
| Busy | `aria-busy="true"` | opacity 0.5 + pointer-events:none |
| Disabled | `is-disabled` class or `[disabled]` on `<button>` | opacity 0.5 + pointer-events:none |

Naming: states are always `is-<state>` (kebab). Never `<state>` alone, never `is_<state>` or camelCase. `is-active` and `.selected` are deprecated — use `is-selected`.

Animations are ephemeral, never persistent styling. `.live-row.is-new` is a one-shot flash that the component removes after the animation completes.

Layering rules:
- Hover + Selected → both apply; selected's border stays, hover's bg shift composes.
- Hover + Busy → busy wins via `pointer-events: none`.
- Focus + anything → outline overlays, doesn't replace.

### Empty states

For any list, table, or stack rendering rows: use a single child with `className="muted empty-row"` instead of conditional containers.

```tsx
{items.length === 0 && (
  <li className="muted empty-row">
    {filtersActive ? "No X match the current filters." : "No X yet."}
  </li>
)}
```

Copy convention:
- **No X yet.** — initial empty (no data ever)
- **No X match the current filters.** — filter-empty (data exists, filters hide it)
- **No X found.** — search-empty (active query, no results)

Use `<li>` inside `<ul>`, `<div>` for non-list contexts, `<tr><td colSpan=...>` for tables. The class is the same.

For page-level empty states (not inside a row container), keep using `<p className="muted small">...</p>` — different concern, different visual.

### Action chips inside clickable rows

When inner buttons/chips shouldn't trigger the row's `onClick`, wrap them in a container with `stopPropagation`:

```tsx
<div className="alert-actions" onClick={(e) => e.stopPropagation()}>
  <button className="chip" onClick={onSnooze}>snooze 7d</button>
  <button className="chip" onClick={onDismiss}>dismiss</button>
</div>
```

## Icons

Inline SVG only. No icon library, no `<img>`. The codebase uses [Tabler Icons](https://tabler-icons.io)' visual style (24×24 viewBox, stroke-only, 1.75px stroke).

Canonical attributes:

```tsx
<svg
  width={16}
  height={16}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  strokeWidth={1.75}
  strokeLinecap="round"
  strokeLinejoin="round"
>
  <path d="..." />
</svg>
```

- `stroke="currentColor"` lets the icon inherit text color from its parent. Always.
- `strokeWidth={1.75}` matches Tabler defaults. The codebase has some 2.0 stragglers — leave them, but new icons use 1.75.
- `width={16}` (number, not string `"16"`) for consistency.
- Common sizes: 14 (inside buttons), 16 (default), 20 (page-level), 24 (large badge).
- No fills. If you find yourself reaching for `fill`, you probably want a different graphic, not an icon.
- **Never emoji**, ever, in any UI surface.

If a new icon doesn't exist in the codebase, copy the SVG path from Tabler and inline it. No icon-component abstraction yet — too much variance in usage context.

## Status indicators

Three families with distinct semantics. Use the one whose meaning matches your data.

| Family | Use | Variants |
|---|---|---|
| `.chip-inline.status-*` | Lifecycle state of an entity or session | `active`, `idle`, `closed`, `retired`, `stale`, `superseded` |
| `.chip-inline.severity-*` | Problem severity ranking | `high`, `medium`, `low` |
| `.dot` (with size mods) | Compact color indicator inside dense layouts | `.dot.lg` for 12px, base 8px |
| `.runtime-dot.runtime-*` | Runtime-specific dot variants | `active` (with glow), `idle`, `dormant` |
| `.live-tag[data-kind="*"]` | Marker badges inside Live feed | `open`, `decision`, `summary`, `label`, `entity` |

When picking:
- **Picking a state for an entity?** → `chip-inline.status-X`
- **Picking a priority for an alert?** → `chip-inline.severity-X`
- **Need a tiny color cue in a row?** → `dot` (or `runtime-dot` if the row is a runtime row)
- **Inside Live feed marker?** → `live-tag`

Don't invent new badge classes. If the data doesn't fit one of these families, talk through whether a new family is warranted before adding CSS.

## Card variants

| Class | Visual | Use |
|---|---|---|
| `.card` | Surface-1 fill, border, 5px radius | Default container. No hover; no scroll body. |
| `.card-lift` | Same + hover lifts to surface-2, border lightens | Cards that respond to hover as a whole (rare; most pages put hover on rows, not the card). |
| `.pulse-scroll-card` | Bounded height + scroll body wrapper required | Cards whose content can overflow vertically (Pulse panels). Pair with `.pulse-scroll-body` for the inner scrolling area. |

The Pulse page wraps each panel section in `.card .pulse-scroll-card .pulse-area-<name>` so the grid template can place them. Settings pages and Recall use plain `.card`.

## Tokens

Defined in `styles.css :root`. Use tokens. Don't reach for raw px/hex/rgb unless the value is genuinely one-off.

**Surfaces:** `--surface-0` (page) → `--surface-1` (card) → `--surface-2` (hover) → `--surface-float` (floating panel).
**Borders:** `--border-1` through `--border-4` (faintest to strongest).
**Text:** `--text-1` through `--text-3` (strongest to most muted).
**Semantic:** `--accent`, `--warn`, `--danger`, plus `--*-dim` and `--*-glow` mixes.
**Type scale:** `--text-xs` (10px) → `--text-sm` (11px) → `--text-base` (13px) → `--text-md` (15px) → `--text-lg` (18px) → `--text-xl` (22px) → `--text-stat` (36px).
**Motion:** `--ease-fast` (100ms) → `--ease` (150ms, default) → `--ease-slow` (300ms).
**Spacing:** `--page-x` (28px), `--section-gap` (24px).
**Shape:** `--r-sm` (3px), `--r-md` (5px), `--r-lg` (7px).

**Color-with-alpha:** there are no `--accent-25` / `--accent-40` etc. tokens. Today these are written inline as `rgba(232,255,110,0.25)`. When a refactor lands, prefer `color-mix(in srgb, var(--accent) 25%, transparent)` for new code. Don't introduce new raw hex values.

**Known font-size outliers:** five callsites use 9px / 12px / 14px / 16px / 24px because no exact token match exists and a 1-2px nudge to the nearest token would be visible at small sizes. Treat these as intentional inline values, not drift. If the type scale grows, fold them in.

## Formatting

`lib/format.ts` is the source of truth for display formatting. One import, one place to change if locale rules shift.

```tsx
import { fmt, relativeAge } from "../lib/format";

fmt.count(1234)                  // "1,234"
fmt.plural(1, "topic")           // "1 topic"
fmt.plural(3, "topic")           // "3 topics"
fmt.plural(3, "child", "children")
fmt.percent(0.382)               // "38%"
fmt.percent(38, { raw: true })   // "38%"
fmt.shortDate("2026-04-12T…")    // "Apr 12, 2026"
fmt.daysBetween(isoA, isoB)      // 7 (floor of (b - a) in days)
relativeAge(iso)                 // "3d", "2mo", "1y"
```

When to reach for which:
- **Relative time** (session ages, alert ages) → `relativeAge` — already canonical
- **Absolute date** (shown only when relative context isn't enough — e.g., a SessionDrawer "Last touched" detail) → `fmt.shortDate`
- **Counts in body text** → `fmt.plural` to handle singular/plural correctly
- **Counts in numeric chrome** (KPIs, chips, totals) → `fmt.count`
- **Percentages** → `fmt.percent`
- **Day deltas** → `fmt.daysBetween`

Never inline `.toLocaleString()` or `n === 1 ? "" : "s"` patterns again — those are the patterns this module replaces.

## Confirmation dialog

Imperative API mirroring browser `confirm()`. Replace native `confirm()` calls — never use the browser dialog. `ConfirmDialog` is mounted once at the app root.

```tsx
import { confirmAction } from "../lib/confirm";

const ok = await confirmAction({
  title: `Delete provider "${row.name}"?`,
  message: "The Classifier will fall back to another provider if this one was active.",
  confirmLabel: "Delete",
  kind: "danger",
});
if (!ok) return;
await deleteProvider(row.id);
```

`kind: "danger"` makes the confirm button red. Default uses `btn-accent`. Backdrop click or Escape cancels. The confirm button auto-focuses on open.

One outstanding at a time. If a new `confirmAction` fires while one is open, the prior resolves to `false` and the new one takes the slot.

When to use:
- **Yes** — destructive irreversible-ish actions: delete, regenerate token, restore from backup.
- **No** — soft actions with their own undo path (dismiss alert → undo from toast, future).
- **No** — form submission validation. That's `.form-error` territory.

## Tooltip

Anchored hint on hover or keyboard focus of a single child. Pure CSS, no JS positioning.

```tsx
<Tooltip text="Snooze 30 days">
  <button type="button" className="btn small">30d</button>
</Tooltip>

<Tooltip text="Currently active session" placement="bottom">
  <span className="runtime-dot runtime-active" />
</Tooltip>
```

When to use:
- **Yes** — icon-only buttons, status dots, truncated labels, anything where the visible affordance can't carry full meaning.
- **No** — descriptive text that should always be visible. Just render it.
- **No** — mouse-tracking data tooltips like the River chart. Those are bespoke and use `.river-hover` directly.

`placement="top"` (default) or `"bottom"`. No left/right yet — add when needed.

## Toast

Fire-and-forget action feedback. Imperative API — no provider, no hook required at the callsite. `ToastHost` is mounted once at the app root.

```tsx
import { toast } from "../lib/toast";

await save();
toast.success("Saved");
// or
toast.error("Failed to save: " + err.message);
// or
toast.info("3 sources scanned");
```

Auto-dismiss: 4s for success/info, 8s for error (errors need more time to read). Override with `toast.success("msg", 2000)`.

When to fire:
- **Yes** — confirmation of an async action that completes silently (dismiss alert, snooze, save settings, regenerate token).
- **No** — synchronous UI state changes where the change is already visible (opening a drawer, toggling a filter).
- **No** — form validation errors. Those go in `.form-error` below the field.

Failed actions go through `toast.error` — never `alert()`.

## Page layout

No `<PageShell>` component — the structure is CSS-class-driven and JSX-light. Page authors compose:

```tsx
<div className="page-pad">
  <SettingsSubnav />               {/* optional, settings only */}
  <div className="form-row between">
    <h2 className="page-title">Sources</h2>
    <button className="btn btn-accent">Add source</button>
  </div>

  {error && <div className="muted error">{error}</div>}
  {loading && <div className="muted">Loading…</div>}

  {/* page body */}
</div>
```

Conventions:

- **`.page-pad`** wraps every page. Sets padding (`20px var(--page-x) 60px`), `flex: 1`, and owns the internal scrolling so the app shell stays locked to viewport height.
- **`.page-title`** is `<h2>`, mono, lg size. Default `margin-bottom: 16px`. Inside `.page-header` or `.form-row.between`, that margin auto-collapses — no inline overrides needed.
- **`.page-header`** is the title + actions row layout (gap-based). Use for "title left, action chip right" without justify-between.
- **`.form-row.between`** for title + button on opposite ends (the Settings pattern).
- **Page-level errors** are surfaced with `<div className="muted error">{error}</div>` above the body. Loading indicators with `<div className="muted">Loading…</div>` work the same way.
- **Action feedback** (success/failure from button clicks) goes through `toast.*`, never inline.

Pages that need a different top-level structure (the `<PulsePage>` skeleton with KPI row + grid) compose their own internal sections inside the same `.page-pad` wrapper.

## Forms

Compose forms with CSS classes — no form components today, since the patterns are simple enough that JSX + classes win on flexibility.

### Layout

| Class | When to use |
|---|---|
| `.form-row` | Inline label + input + (optional) button row. Default 12px gap, wraps. |
| `.form-row.between` | Same, with `justify-content: space-between` — header rows with title left, action right. |
| `.form-row.tight` | Same, with 8px gap — denser action button rows. |
| `.form-grid` | Vertical stack of fields, max-width 420px. For full form layouts. |
| `.form-field` | Single field column (label + input stacked). |

### Field

```tsx
<div className="form-row">
  <label className="form-label" htmlFor="name">Name</label>
  <input
    id="name"
    className="form-input form-input-inline"
    value={name}
    onChange={(e) => setName(e.target.value)}
    disabled={busy}
    aria-invalid={!!nameError}
  />
</div>
{nameError && <p className="form-error">{nameError}</p>}
```

`.form-input` is the base; `.form-input-inline` makes it denser (3px 8px). Today the inline variant is the de facto default — use it unless the field is the only content of a row.

### States

| State | How to mark | Visual |
|---|---|---|
| Hover (mouse) | `:hover` | border-color one step up |
| Focus (keyboard) | `:focus-visible` | 1px accent outline (matches row focus rule) |
| Disabled | `disabled` attribute or `.is-disabled` | opacity 0.5, cursor not-allowed |
| Invalid | `aria-invalid="true"` or `.is-invalid` | danger border; danger focus ring when active |

### Errors

- **Field-level error** below an input: `<p className="form-error">…</p>`. Danger color, xs font, 4px top margin.
- **Page-level error** at the top of a section: `<div className="muted error">…</div>` (existing pattern, keep using it).
- **Never use `alert()`** for form errors. Route through state and render with `.form-error` or `.muted error`.

### Required fields

No convention yet — the codebase doesn't currently mark required fields visually. When this becomes a concern, add a `.form-label.required` rule that appends ` *` via `::after`.

## Inline styles in TSX

Use `style={{...}}` only for **data-driven** values that can't be expressed in CSS:

- Colors that come from data (`background: entityColor`, `borderColor: entityColors[id]`)
- Calculated positions (`left: hover.x + 12`)
- Computed percentages (`width: ${(v/max)*100}%` for bar fills)

Everything else — padding, margin, gap, flex, justify, layout — belongs in a CSS class. If you're tempted to inline `padding: "8px 14px"` you're re-implementing row chrome; reach for `.list-action-row`, `.empty-row`, or a new utility class instead.

**rem units are not part of the system.** The codebase uses px-based tokens (`--text-*`, fixed pixel paddings). If you see `style={{ padding: "1rem" }}` in new code, replace with the appropriate px value or token before merging.

## Buttons

Composed via `.btn` + a variant modifier. Use semantic variants — never invent visual one-offs.

| Class | Visual | When to use |
|---|---|---|
| `.btn` | neutral, transparent + border | secondary actions, dismissive options |
| `.btn .btn-primary` | filled with accent, bold | primary submit / commit action |
| `.btn .btn-accent` | accent-colored text, subtle border | primary navigation action ("Open thread") |
| `.btn .btn-danger` | neutral until hover (then red) | destructive actions (Dismiss, Delete). Hover-only color signals "do this with intent." |
| `.btn .small` | smaller padding + xs font | row-level actions in tables/dense lists |

`.btn-danger` is intentional: it inherits `.btn` for its base state. Don't add a base background or color — the muted-until-hover pattern reduces accidental clicks on destructive actions.

`.btn.active` (lowercase `active`, NOT `is-active`) is the existing convention for "currently the chosen action in a group" — different concept than `is-selected` on rows. Buttons toggle, rows select.

## Z-index scale

Never write a raw `z-index` value. Pick the token that matches the semantic role. Scale defined in `styles.css :root` with 10-unit gaps so future "between" cases can land at intermediate values.

| Token | Value | Use |
|---|---|---|
| `--z-base` | 0 | default stacking |
| `--z-raised` | 1 | hover-to-front, chart layer reordering |
| `--z-sticky` | 10 | sticky page headers |
| `--z-sidenav` | 20 | sidenav rail |
| `--z-dropdown` | 30 | anchored menus, kebab dropdowns |
| `--z-overlay` | 40 | generic overlay layers (selection rects) |
| `--z-drawer-bg` | 50 | drawer/modal backdrop |
| `--z-drawer` | 60 | drawer panel |
| `--z-palette-bg` | 70 | palette backdrop (sits above drawer) |
| `--z-palette` | 80 | command palette |
| `--z-tooltip` | 90 | tooltips |
| `--z-toast` | 100 | toasts/notifications |

If you find yourself wanting "just below X", add a layer to the scale instead.

## Design rules

Encoded in `styles.css`. New components must respect:

- **Hover surface step**: an interactive element on `--surface-N` hovers to `--surface-(N+1)`. Never to the same surface as the parent (invisible). Topmost is `--surface-float`.
- **Cursor**: every interactive element declares `cursor: pointer` on itself, never relying on a child `<Link>` for the cue.
- **Label tint**: clickable rows tint their primary label to `var(--accent)` on hover.
- **Action chip isolation**: any inner action UI inside a clickable row needs `stopPropagation`.
- **No new drawer HTML**: writing raw `.drawer-backdrop` / `.session-drawer` / `.drawer-head` outside the components is a regression. Use `<Drawer>`.

## Not yet extracted (rule of three)

These patterns are recognised but the duplication isn't high enough to justify the abstraction. Track them — extract when a third instance lands.

- **Palette** — only `SupersedePalette` exists. When a second centered command palette appears, extract `<Palette>`.
- **Popover / anchored menu** — `MarkerActionMenu`, the kebab menu in `SessionDrawer`, and `PromoteOpenButton`'s edit form all share the click-outside + Escape + small-floating-surface pattern but are different enough that forcing a shared abstraction now would distort each. Document the click-outside hook if a fourth lands.
- **FilterGroup / FilterChip** — see step in the open roadmap (next to extract). Severity/sort/count chips in `AlertDrawer` and `CoherenceDrawer` are duplicated.

## Adding a new component

1. Confirm the pattern appears in three places or has clear forward demand.
2. Land the component with one consumer migrated.
3. Update this README in the same change.
4. Migrate other consumers in follow-up changes — don't bundle.
5. Add an audit step to `styles.css` (or test) that flags regressions to raw HTML.
