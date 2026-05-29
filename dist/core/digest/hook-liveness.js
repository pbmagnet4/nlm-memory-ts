/**
 * Hook liveness check — the load-bearing canary for post-install hook drift.
 *
 * The setup-time smoke test catches malformed hook commands at install moment
 * but nothing detects later drift: a node upgrade that moves the binary, a
 * Claude Code hook dispatcher change, hand-edits to `~/.claude/settings.json`,
 * a `dist/` move. Any of these silently stop the hook firing while Claude Code
 * keeps working. Without correlation, the user only notices when recall
 * mysteriously stops appearing — weeks later.
 *
 * The check: if the user ran Claude Code yesterday but no live hook fires were
 * logged, surface an alert. Silence is allowed only when Claude Code itself
 * was silent.
 */
/** Returns an alert string if Claude Code ran yesterday but the hook did not. */
export function checkHookLiveness(input) {
    const now = input.now ?? new Date();
    const { start, end } = yesterdayWindow(now);
    const ccYesterday = input.sessions.reduce((n, s) => {
        if (!s.runtime || !s.runtime.startsWith("claude-code"))
            return n;
        const ts = s.started_at ? Date.parse(s.started_at) : NaN;
        if (!Number.isFinite(ts))
            return n;
        return ts >= start && ts < end ? n + 1 : n;
    }, 0);
    if (ccYesterday === 0) {
        return null; // No Claude Code usage; silence is expected.
    }
    if (!input.hookLogExists) {
        return (`WARN hook silent: ${ccYesterday} Claude Code sessions yesterday, ` +
            `0 hook fires (log file missing at ${input.hookLogPath})`);
    }
    const liveYesterday = input.hookLog.reduce((n, entry) => {
        if (entry.mode !== "live")
            return n;
        const ts = entry.ts ? Date.parse(entry.ts) : NaN;
        if (!Number.isFinite(ts))
            return n;
        return ts >= start && ts < end ? n + 1 : n;
    }, 0);
    if (liveYesterday === 0) {
        return (`WARN hook silent: ${ccYesterday} Claude Code sessions yesterday, ` +
            `0 live hook fires — check \`nlm hook install\` + ~/.claude/settings.json`);
    }
    return null;
}
/** Local-time yesterday window as [start, end) epoch ms. */
function yesterdayWindow(now) {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
    return { start: yesterdayStart, end: todayStart };
}
//# sourceMappingURL=hook-liveness.js.map