import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { confirmAction } from "../../lib/confirm.js";

interface TableStat {
  name: string;
  rows: number;
}

interface MigrationRow {
  version: number;
  name: string;
  applied_at: string;
}

interface RuntimeStat {
  runtime: string;
  n: number;
}

interface DataStats {
  dbPath: string;
  dbBytes: number;
  dbPresent: boolean;
  schemaVersion: number | null;
  migrations: MigrationRow[];
  tables: TableStat[];
  runtimes: RuntimeStat[];
}

interface RestoreResult {
  staged?: boolean;
  restartRequired?: boolean;
  sessions?: number;
  schemaVersion?: number;
  error?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function SettingsDataPage() {
  const [stats, setStats] = useState<DataStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState<RestoreResult | null>(null);
  const [restoring, setRestoring] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/data/stats");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStats((await r.json()) as DataStats);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submitRestore = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const ok = await confirmAction({
      title: `Restore from "${file.name}"?`,
      message: "Your current database is archived (not deleted), and the new one takes effect after the daemon restarts.",
      confirmLabel: "Restore",
      kind: "danger",
    });
    if (!ok) return;
    setRestoring(true);
    setRestore(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/data/restore", { method: "POST", body: fd });
      const data = (await r.json()) as RestoreResult;
      setRestore(data);
      if (data.staged && fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setRestore({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <h2 className="page-title">Data</h2>
      {!stats && !error && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}

      {stats && (
        <>
          <h3 className="section-title">Storage</h3>
          <dl className="kv-list">
            <dt className="kv-label">Canonical SQLite</dt>
            <dd className="kv-value mono">{stats.dbPath}</dd>
            <dt className="kv-label">On disk</dt>
            <dd className="kv-value mono">
              {formatBytes(stats.dbBytes)}
              {!stats.dbPresent && <span className="muted small"> · file missing</span>}
            </dd>
            <dt className="kv-label">Schema version</dt>
            <dd className="kv-value mono">
              {stats.schemaVersion ?? "—"}
              {stats.migrations.length > 0 && (
                <span className="muted small"> · {stats.migrations.length} migrations applied</span>
              )}
            </dd>
          </dl>

          <h3 className="section-title">Tables</h3>
          <table className="data-table">
            <thead><tr><th>Table</th><th>Rows</th></tr></thead>
            <tbody>
              {stats.tables.map((t) => (
                <tr key={t.name}>
                  <td className="mono small">{t.name}</td>
                  <td className="mono">{t.rows.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {stats.runtimes.length > 0 && (
            <>
              <h3 className="section-title">Sessions by runtime</h3>
              <table className="data-table">
                <thead><tr><th>Runtime</th><th>Sessions</th></tr></thead>
                <tbody>
                  {stats.runtimes.map((r) => (
                    <tr key={r.runtime}>
                      <td className="mono small">{r.runtime}</td>
                      <td className="mono">{r.n.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h3 className="section-title">Backup</h3>
          <p className="muted small">
            Downloads a clean, defragmented snapshot of the canonical store. Safe to run while the daemon is ingesting.
          </p>
          <div className="form-row">
            <a className="btn btn-accent" href="/api/data/backup" download>
              Download backup
            </a>
          </div>

          <h3 className="section-title">Restore</h3>
          <p className="muted small">
            Replace the canonical store with an <code>.sqlite</code> backup. The current database is archived
            alongside it (<code>.pre-restore-&lt;timestamp&gt;</code>), never deleted. Takes effect on the next daemon restart.
          </p>
          <div className="form-row">
            <input
              ref={fileRef}
              type="file"
              accept=".sqlite,application/x-sqlite3"
              className="file-input"
              disabled={restoring}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void submitRestore()}
              disabled={restoring}
            >{restoring ? "Validating…" : "Restore from backup"}</button>
          </div>
          {restore?.staged && (
            <div className="card card-data-validated">
              <p className="small data-validated-text">
                Backup validated and staged ({restore.sessions?.toLocaleString()} sessions, schema v{restore.schemaVersion}).
                <strong> Restart the daemon</strong> to apply it. Your current database will be archived automatically.
              </p>
            </div>
          )}
          {restore?.error && <p className="muted error small">{restore.error}</p>}
        </>
      )}
    </div>
  );
}
