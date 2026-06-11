import { useCallback, useEffect, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { toast } from "../../lib/toast.js";
import { confirmAction } from "../../lib/confirm.js";
import {
  fetchSources,
  SOURCE_KINDS,
  SOURCE_KIND_LABEL,
  SOURCE_PRESETS,
  type SourceKind,
  type SourceRow,
} from "../../lib/registries.js";

export function SettingsSourcesPage() {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [revealedToken, setRevealedToken] = useState<{ name: string; token: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSources(await fetchSources());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleEnabled = async (row: SourceRow) => {
    await fetch(`/api/sources/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !row.enabled }),
    });
    await load();
  };

  const remove = async (row: SourceRow) => {
    const ok = await confirmAction({
      title: `Delete source "${row.name}"?`,
      message: "This stops scanning but leaves ingested sessions in place.",
      confirmLabel: "Delete",
      kind: "danger",
    });
    if (!ok) return;
    await fetch(`/api/sources/${row.id}`, { method: "DELETE" });
    await load();
  };

  const regenerateToken = async (row: SourceRow) => {
    const ok = await confirmAction({
      title: `Regenerate token for "${row.name}"?`,
      message: "Any client using the current token will stop working.",
      confirmLabel: "Regenerate",
      kind: "danger",
    });
    if (!ok) return;
    const r = await fetch(`/api/sources/${row.id}/regenerate-token`, { method: "POST" });
    const data = (await r.json()) as { token?: string; error?: string };
    if (data.token) {
      setRevealedToken({ name: row.name, token: data.token });
      await load();
    } else {
      toast.error(`Failed to regenerate token: ${data.error ?? r.statusText}`);
    }
  };

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <div className="form-row between">
        <h2 className="page-title">Sources</h2>
        <button type="button" className="btn btn-accent" onClick={() => setShowWizard(true)}>
          Add source
        </button>
      </div>

      {revealedToken && (
        <TokenBanner
          name={revealedToken.name}
          token={revealedToken.token}
          onDismiss={() => setRevealedToken(null)}
        />
      )}

      {loading && sources.length === 0 && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}

      {sources.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Runtime</th>
              <th>Path / URL</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.name}</td>
                <td>{SOURCE_KIND_LABEL[s.kind]}</td>
                <td className="mono small">{s.runtimeLabel}</td>
                <td className="mono small">{s.pathOrUrl ?? (s.kind === "webhook" ? "—" : "")}</td>
                <td>
                  <span className={`chip-inline ${s.enabled ? "status-active" : "status-stale"}`}>
                    {s.enabled ? "enabled" : "disabled"}
                  </span>
                </td>
                <td>
                  <div className="form-row tight">
                    <button type="button" className="btn small" onClick={() => void toggleEnabled(s)}>
                      {s.enabled ? "Disable" : "Enable"}
                    </button>
                    {s.kind === "webhook" && (
                      <button type="button" className="btn small" onClick={() => void regenerateToken(s)}>
                        Regenerate token
                      </button>
                    )}
                    <button type="button" className="btn small" onClick={() => void remove(s)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!loading && sources.length === 0 && (
        <p className="muted small">No sources yet. Click "Add source" to scan your first transcript directory.</p>
      )}

      {showWizard && (
        <AddSourceWizard
          onClose={() => setShowWizard(false)}
          onCreated={(created) => {
            setShowWizard(false);
            if (created.kind === "webhook" && created.token) {
              setRevealedToken({ name: created.name, token: created.token });
            }
            void load();
          }}
        />
      )}
    </div>
  );
}

function TokenBanner({ name, token, onDismiss }: { name: string; token: string; onDismiss: () => void }) {
  return (
    <div className="card card-accent">
      <h3 className="section-title section-title-no-mt">One-time token for "{name}"</h3>
      <p className="muted small">
        Copy this now. It's stored hashed on the daemon and won't be shown again. Send sessions with{" "}
        <code>Authorization: Bearer &lt;token&gt;</code> to <code>POST /api/ingest</code>.
      </p>
      <pre className="mono card-accent-padded">{token}</pre>
      <div className="form-row">
        <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(token)}>
          Copy
        </button>
        <button type="button" className="btn btn-accent" onClick={onDismiss}>
          I've stored it
        </button>
      </div>
    </div>
  );
}

interface CreatedSource extends SourceRow {}

function AddSourceWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (s: CreatedSource) => void;
}) {
  const [kind, setKind] = useState<SourceKind>("claude-code");
  const preset = SOURCE_PRESETS[kind];
  const [name, setName] = useState(preset.name);
  const [runtimeLabel, setRuntimeLabel] = useState(preset.runtimeLabel);
  const [pathOrUrl, setPathOrUrl] = useState<string>(preset.pathOrUrl ?? "");
  const [jsonlConfig, setJsonlConfig] = useState({
    idField: "session_id",
    textField: "text",
    startedAtField: "started_at",
    endedAtField: "ended_at",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const p = SOURCE_PRESETS[kind];
    setName(p.name);
    setRuntimeLabel(p.runtimeLabel);
    setPathOrUrl(p.pathOrUrl ?? "");
    setErr(null);
  }, [kind]);

  const needsPath = kind !== "webhook";
  const isCustomJsonl = kind === "jsonl-generic";

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        kind,
        name,
        runtimeLabel,
      };
      if (needsPath) body["pathOrUrl"] = pathOrUrl;
      if (isCustomJsonl) body["parseConfig"] = jsonlConfig;
      const r = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as CreatedSource & { error?: string };
      if (!r.ok || data.error) {
        setErr(data.error ?? r.statusText);
        return;
      }
      onCreated(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    !busy &&
    name.length > 0 &&
    runtimeLabel.length > 0 &&
    (!needsPath || pathOrUrl.length > 0);

  return (
    <div className="card card-wide-input">
      <h3 className="section-title section-title-no-mt">Add source</h3>

      <div className="form-row">
        <label className="form-label">Kind</label>
        <select
          className="form-input form-input-inline"
          value={kind}
          onChange={(e) => setKind(e.target.value as SourceKind)}
          disabled={busy}
        >
          {SOURCE_KINDS.map((k) => (
            <option key={k} value={k}>{SOURCE_KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>

      <div className="form-row">
        <label className="form-label">Name</label>
        <input
          className="form-input form-input-inline"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isCustomJsonl || kind === "webhook" ? "e.g. my-agent" : ""}
          disabled={busy}
        />
        <label className="form-label">Runtime label</label>
        <input
          className="form-input form-input-inline"
          value={runtimeLabel}
          onChange={(e) => setRuntimeLabel(e.target.value)}
          placeholder="appears on Pulse Runtimes card"
          disabled={busy}
        />
      </div>

      {needsPath && (
        <div className="form-row">
          <label className="form-label">{kind === "jsonl-generic" ? "Directory" : "Path"}</label>
          <input
            className="form-input form-input-inline"
                        value={pathOrUrl}
            onChange={(e) => setPathOrUrl(e.target.value)}
            placeholder="absolute or ~/ path to JSONL directory"
            disabled={busy}
          />
        </div>
      )}

      {isCustomJsonl && (
        <>
          <h4 className="section-title section-title-xs">JSONL field mapping</h4>
          <p className="muted small">
            How to read your JSONL files. Each row should be one session. Use dot.notation for nested fields.
          </p>
          {(["idField", "textField", "startedAtField", "endedAtField"] as const).map((f) => (
            <div className="form-row" key={f}>
              <label className="form-label">{f}</label>
              <input
                className="form-input form-input-inline"
                value={jsonlConfig[f]}
                onChange={(e) => setJsonlConfig({ ...jsonlConfig, [f]: e.target.value })}
                disabled={busy}
              />
            </div>
          ))}
        </>
      )}

      {kind === "webhook" && (
        <p className="muted small">
          A bearer token will be generated and shown <strong>once</strong> when you create this source.
          Use it to <code>POST /api/ingest</code> from any agent or script.
        </p>
      )}

      {err && <p className="form-error">{err}</p>}

      <div className="form-row">
        <button type="button" className="btn btn-accent" onClick={() => void submit()} disabled={!canSubmit}>
          {busy ? "Creating…" : "Create"}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
