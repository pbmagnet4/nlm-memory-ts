/**
 * Session-list filters used before scoring.
 *
 * Pure function over a session array. Mirrors recall.py:_apply_filters.
 */
export function applyFilter(sessions, filter) {
    const { entity, kind } = filter;
    if (!entity && !kind)
        return sessions;
    return sessions.filter((s) => {
        if (entity && !s.entities.includes(entity))
            return false;
        if (kind === "decision" && s.decisions.length === 0)
            return false;
        if (kind === "open" && s.open.length === 0)
            return false;
        return true;
    });
}
//# sourceMappingURL=filter.js.map