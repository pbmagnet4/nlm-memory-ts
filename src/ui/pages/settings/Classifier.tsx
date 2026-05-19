import { useEffect, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";

interface ClassifierInfo {
  provider: string;
  model: string;
  available_providers: string[];
  env_present: Record<string, boolean>;
  default_models: Record<string, string[]>;
}

export function SettingsClassifierPage() {
  const [info, setInfo] = useState<ClassifierInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/classifier/info")
      .then((r) => r.json() as Promise<ClassifierInfo>)
      .then(setInfo)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <h2 className="page-title">Classifier</h2>
      {!info && !error && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}
      {info && (
        <>
          <dl className="kv-list">
            <dt className="kv-label">Active provider</dt>
            <dd className="kv-value mono">{info.provider}</dd>
            <dt className="kv-label">Active model</dt>
            <dd className="kv-value mono">{info.model}</dd>
          </dl>
          <h3 className="section-title">Available providers</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>API key present</th>
                <th>Default models</th>
              </tr>
            </thead>
            <tbody>
              {info.available_providers.map((p) => (
                <tr key={p}>
                  <td className="mono">{p}</td>
                  <td>
                    <span className={`chip-inline ${info.env_present[p] ? "status-active" : "status-stale"}`}>
                      {info.env_present[p] ? "yes" : "no"}
                    </span>
                  </td>
                  <td className="mono small">
                    {(info.default_models[p] ?? []).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="section-title">Switching providers</h3>
          <p className="muted">Hot-swap is wired but a UI control isn't yet ported. Until then, set <code>NLE_CLASSIFIER=ollama</code> (or <code>deepseek</code>) and restart the daemon.</p>
          <pre className="code-block">launchctl kickstart -k gui/$UID/io.whtnxt.nle-memory-ts</pre>
        </>
      )}
    </div>
  );
}
