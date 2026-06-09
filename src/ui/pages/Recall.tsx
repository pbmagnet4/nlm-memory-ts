/**
 * Recall — adoption + coverage telemetry for the memory system.
 *
 * Two surfaces, two audiences:
 *   - Session recall  → what the orchestrator pulls answering questions
 *                       about past work (the human-operator surface).
 *   - Fact recall     → structured facts agents pull mid-task.
 *
 * Hit rate answers "did recall return something," not "did the agent use
 * it." By-source answers "is anything calling this at all." Read together
 * they distinguish an adoption problem from a corpus-coverage problem.
 */

import { useState, useEffect } from "react";
import { usePolledEndpoint, fetchFailureModeStats, type FailureModeStats, type UiFailureMode } from "../lib/api.js";
import { fmt } from "../lib/format.js";

interface BaseStats {
  days: number;
  total: number;
  with_results: number;
  hit_rate: number;
  by_source: Record<string, number>;
  log_present: boolean;
}

interface SessionStats extends BaseStats {
  top_queries: { query: string; count: number }[];
}

interface FactStats extends BaseStats {
  top_subjects: { subject: string; count: number }[];
  top_predicates: { predicate: string; count: number }[];
}

const EMPTY_SESSION: SessionStats = {
  days: 7, total: 0, with_results: 0, hit_rate: 0, by_source: {}, top_queries: [], log_present: false,
};
const EMPTY_FACT: FactStats = {
  days: 7, total: 0, with_results: 0, hit_rate: 0, by_source: {}, top_subjects: [], top_predicates: [], log_present: false,
};

const WINDOWS = [7, 30, 90] as const;

// Source labels come from different entry points (per-prompt hook,
// session-start hook, MCP tools, HTTP API, CLI). The raw keys are
// kept stable for log compatibility; this map renders them as
// human-readable names. Anything not in the map falls back to the raw key.
const SOURCE_LABELS: Record<string, string> = {
  "hook": "Prompt hook (per user prompt)",
  "session-start-hook": "Session start hook",
  "mcp": "MCP tool",
  "http": "HTTP / browser",
  "cli": "CLI",
};

function formatSourceLabel(raw: string): string {
  return SOURCE_LABELS[raw] ?? raw;
}

interface BarRow {
  label: string;
  count: number;
}

export function RecallPage() {
  const [days, setDays] = useState<number>(7);
  const session = usePolledEndpoint<SessionStats>(`/api/recall/stats?days=${days}`, 30_000, EMPTY_SESSION);
  const facts = usePolledEndpoint<FactStats>(`/api/recall/facts/stats?days=${days}`, 30_000, EMPTY_FACT);

  return (
    <div className="page-pad">
      <div className="recall-head">
        <p className="muted small recall-note">
          Hit rate measures whether recall returned something — not whether the agent used it.
          Watch <strong>by source</strong> for adoption and <strong>hit rate</strong> for
          whether the corpus covers what's being asked.
        </p>
        <div className="filter-group" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={`chip${days === w ? " active" : ""}`}
              onClick={() => setDays(w)}
            >{w}d</button>
          ))}
        </div>
      </div>

      <StatsBlock
        title="Session recall"
        subtitle="What the orchestrator pulls when answering questions about past work — the human-operator surface."
        stats={session.data}
        error={session.error}
        topLabel="Top queries"
        topRows={session.data.top_queries.map((q) => ({ label: q.query, count: q.count }))}
      />

      <StatsBlock
        title="Fact recall"
        subtitle="Structured facts agents pull mid-task — the orchestrator surface."
        stats={facts.data}
        error={facts.error}
        topLabel="Top subjects"
        topRows={facts.data.top_subjects.map((s) => ({ label: s.subject, count: s.count }))}
        extraLabel="Top predicates"
        extraRows={facts.data.top_predicates.map((p) => ({ label: p.predicate, count: p.count }))}
      />

      <FailureModesPanel />
    </div>
  );
}

interface StatsBlockProps {
  title: string;
  subtitle: string;
  stats: BaseStats;
  error: string | null;
  topLabel: string;
  topRows: BarRow[];
  extraLabel?: string;
  extraRows?: BarRow[];
}

function StatsBlock({ title, subtitle, stats, error, topLabel, topRows, extraLabel, extraRows }: StatsBlockProps) {
  const zeroResult = stats.total - stats.with_results;
  const sourceRows: BarRow[] = Object.entries(stats.by_source)
    .map(([label, count]) => ({ label: formatSourceLabel(label), count }))
    .sort((a, b) => b.count - a.count);

  return (
    <section className="recall-block">
      <header className="recall-block-head">
        <h2 className="page-title">{title}</h2>
        <p className="muted small">{subtitle}</p>
      </header>

      {error && <div className="muted error small">{error}</div>}

      {!stats.log_present ? (
        <div className="card recall-empty muted">
          No query log on disk yet — nothing has called this recall surface.
        </div>
      ) : stats.total === 0 ? (
        <div className="card recall-empty muted">
          No queries in the last {stats.days} days. The log exists but this window is empty.
        </div>
      ) : (
        <>
          <div className="kpi-row">
            <Kpi label="Queries" value={stats.total} hint={`last ${stats.days}d`} />
            <Kpi
              label="Hit rate"
              value={`${Math.round(stats.hit_rate * 100)}%`}
              hint={`${stats.with_results.toLocaleString()} returned ≥1`}
            />
            <Kpi
              label="Zero-result"
              value={zeroResult}
              hint={zeroResult > 0 ? "corpus gaps" : "full coverage"}
            />
            <Kpi label="Sources" value={sourceRows.length} hint="distinct callers" />
          </div>

          <div className="recall-cards">
            <BarCard title="By source" rows={sourceRows} emptyText="No sources recorded." />
            <BarCard title={topLabel} rows={topRows} emptyText="None recorded." />
            {extraLabel && extraRows && (
              <BarCard title={extraLabel} rows={extraRows} emptyText="None recorded." />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Kpi({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{typeof value === "number" ? value.toLocaleString() : value}</span>
      {hint && <span className="kpi-hint">{hint}</span>}
    </div>
  );
}

const EMPTY_FAILURE_STATS: FailureModeStats = { days: 14, total: 0, modes: [] };

function FailureModesPanel() {
  const [stats, setStats] = useState<FailureModeStats>(EMPTY_FAILURE_STATS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchFailureModeStats(14)
      .then(setStats)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <section className="recall-block">
      <header className="recall-block-head">
        <h2 className="page-title">Failure modes (14d)</h2>
        <p className="muted small">
          Per-model, per-repo check failure rates over the last 14 days. Rates above 50% are flagged red.
        </p>
      </header>

      {error && <div className="muted error small">{error}</div>}

      <section className="card">
        {stats.modes.length === 0 ? (
          <div className="muted empty-row">No failure modes captured yet.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Repo</th>
                <th>Check</th>
                <th>Fail rate</th>
                <th>n</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {stats.modes.map((m: UiFailureMode, i: number) => (
                <tr key={i}>
                  <td className="mono">{m.model}</td>
                  <td>{m.repo}</td>
                  <td>{m.step ? `${m.kind} / ${m.step}` : m.kind}</td>
                  <td>
                    <span className={`chip-inline severity-${m.failRate >= 0.5 ? "high" : "medium"}`}>
                      {Math.round(m.failRate * 100)}%
                    </span>
                  </td>
                  <td className="mono">{m.total.toLocaleString()}</td>
                  <td className="muted">{fmt.shortDate(m.lastTs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}

function BarCard({ title, rows, emptyText }: { title: string; rows: BarRow[]; emptyText: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="card">
      <header className="card-head"><h3>{title}</h3></header>
      <div className="bar-stack recall-bars">
        {rows.length === 0 && <div className="muted empty-row">{emptyText}</div>}
        {rows.map((r) => (
          <div key={r.label} className="bar-item">
            <span className="bar-label recall-bar-label" title={r.label}>{r.label}</span>
            <div className="bar-track">
              <div className="bar-fill tone-active" style={{ width: `${(r.count / max) * 100}%` }} />
            </div>
            <span className="bar-value mono">{r.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
