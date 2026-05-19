import { SettingsSubnav } from "./SettingsSubnav.js";
import { useDataset, relativeAge } from "../../lib/dataset.js";

export function SettingsDataPage() {
  const { data, loading, error } = useDataset();
  return (
    <div className="page-pad">
      <SettingsSubnav />
      <h2 className="page-title">Data</h2>
      {loading && !data && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}
      {data && (
        <dl className="kv-list">
          <KV label="Canonical SQLite" value={data.meta.db_path} mono />
          <KV label="Sessions" value={String(data.meta.sessions_total)} />
          <KV label="Entities" value={String(data.meta.entities_total)} />
          <KV label="DB present" value={data.meta.db_present ? "yes" : "no"} />
          <KV label="Last sync" value={`${relativeAge(data.meta.last_sync)} ago`} />
        </dl>
      )}
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="kv-label">{label}</dt>
      <dd className={`kv-value${mono ? " mono" : ""}`}>{value}</dd>
    </>
  );
}
