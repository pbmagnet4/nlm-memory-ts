/**
 * Daily digest text composer.
 *
 * Pure function: takes the raw shapes the daemon returns and emits the digest
 * body. No I/O, no Telegram, no fetch — those live in the CLI adapter so this
 * module stays unit-testable without HTTP fixtures.
 *
 * The 7-day numbers come from the server-computed stats (`/api/recall/stats`).
 * The 24-hour slice is derived locally from `recent`, because the server's
 * stats window is fixed at 7 days and we want a tighter view for the morning
 * push. Probe/test queries are filtered out of both windows.
 */
/** Substrings that mark a recall as test traffic, not real agent usage. */
export const PROBE_PATTERNS = [
    "concurrency probe",
    "test probe",
    "path test",
    "recall test",
    "smoke",
    "cutover-test",
];
export function isProbe(query) {
    if (!query)
        return false;
    const q = query.toLowerCase();
    return PROBE_PATTERNS.some((p) => q.includes(p));
}
export function composeDigest(input) {
    const now = input.now ?? new Date();
    const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
    const real24h = [];
    for (const e of input.recent) {
        const ts = Date.parse(e.ts);
        if (!Number.isFinite(ts) || ts < cutoff)
            continue;
        if (isProbe(e.query))
            continue;
        real24h.push(e);
    }
    const sources = new Map();
    const queries = new Map();
    for (const e of real24h) {
        const src = e.source ?? "?";
        sources.set(src, (sources.get(src) ?? 0) + 1);
        if (e.query)
            queries.set(e.query, (queries.get(e.query) ?? 0) + 1);
    }
    const sourceStr = [...sources.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`).join(" · ") || "none";
    const topQ = [...queries.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    // 7-day real-traffic estimate: strip probes from the server's top_queries
    // counters. The server-side top_queries is capped (typically 20) so this is
    // a floor on probe traffic, not an exact subtraction. Good enough to keep
    // the morning numbers honest.
    const probes7d = input.stats.top_queries.reduce((sum, { query, count }) => (isProbe(query) ? sum + count : sum), 0);
    const total7d = input.stats.total;
    const real7d = Math.max(total7d - probes7d, 0);
    const usefulLine = input.stats.useful_hit_rate === null
        ? "useful_hit_rate: pending (run `nlm useful-scan`)"
        : `useful_hit_rate (7d): ${pct(input.stats.useful_hit_rate)}`;
    const topLines = topQ.length === 0
        ? "  (none)"
        : topQ.map(([q, _], i) => `  ${i + 1}. ${truncate(q, 60)}`).join("\n");
    const todayStr = formatDay(now);
    const alertBlock = input.hookAlert ? `${input.hookAlert}\n\n` : "";
    return (`NLM digest — ${todayStr}\n` +
        `\n` +
        alertBlock +
        `Last 24h (real traffic): ${real24h.length} queries · ${sourceStr}\n` +
        `Last 7d: ${real7d} real / ${total7d} total · hit_rate ${pct(input.stats.hit_rate)}\n` +
        `${usefulLine}\n` +
        `\n` +
        `Top real queries (24h):\n` +
        `${topLines}\n` +
        `\n` +
        `UI: http://localhost:${input.port}/ui/`);
}
function pct(n) {
    return `${Math.round(n * 100)}%`;
}
function truncate(s, max) {
    return s.length <= max ? s : s.slice(0, max);
}
function formatDay(d) {
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${weekday} ${y}-${m}-${day}`;
}
//# sourceMappingURL=compose.js.map