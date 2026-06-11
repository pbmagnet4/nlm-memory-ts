import { useCallback, useEffect, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { confirmAction } from "../../lib/confirm.js";
import {
  fetchProviders,
  testProvider,
  PROVIDER_KINDS,
  PROVIDER_KIND_LABEL,
  PROVIDER_PRESETS,
  type ProviderKind,
  type ProviderRow,
  type TestResult,
} from "../../lib/registries.js";

export function SettingsProvidersPage() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [testStates, setTestStates] = useState<Record<number, TestResult | "running">>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProviders(await fetchProviders());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleEnabled = async (row: ProviderRow) => {
    await fetch(`/api/providers/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !row.enabled }),
    });
    await load();
  };

  const remove = async (row: ProviderRow) => {
    const ok = await confirmAction({
      title: `Delete provider "${row.name}"?`,
      message: "The Classifier will fall back to another provider if this one was active.",
      confirmLabel: "Delete",
      kind: "danger",
    });
    if (!ok) return;
    await fetch(`/api/providers/${row.id}`, { method: "DELETE" });
    await load();
  };

  const runTest = async (row: ProviderRow) => {
    setTestStates((s) => ({ ...s, [row.id]: "running" }));
    try {
      const r = await testProvider(row.id);
      setTestStates((s) => ({ ...s, [row.id]: r }));
    } catch (e) {
      setTestStates((s) => ({
        ...s,
        [row.id]: { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <div className="form-row between">
        <h2 className="page-title">Providers</h2>
        <button type="button" className="btn btn-accent" onClick={() => setShowWizard(true)}>
          Add provider
        </button>
      </div>

      {loading && providers.length === 0 && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}

      {providers.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Base URL</th>
              <th>Default model</th>
              <th>API key</th>
              <th>Status</th>
              <th>Last test</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const t = testStates[p.id];
              return (
                <tr key={p.id}>
                  <td className="mono">{p.name}</td>
                  <td>{PROVIDER_KIND_LABEL[p.kind]}</td>
                  <td className="mono small">{p.baseUrl ?? "—"}</td>
                  <td className="mono small">{p.defaultModel ?? "—"}</td>
                  <td>
                    {p.kind === "ollama" || p.kind === "openai-compatible" ? (
                      <span className="muted small">{p.hasApiKey ? "set" : "n/a"}</span>
                    ) : (
                      <span className={`chip-inline ${p.hasApiKey ? "status-active" : "status-stale"}`}>
                        {p.hasApiKey ? "set" : "missing"}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`chip-inline ${p.enabled ? "status-active" : "status-stale"}`}>
                      {p.enabled ? "enabled" : "disabled"}
                    </span>
                  </td>
                  <td className="small">
                    {t === "running" && <span className="muted">testing…</span>}
                    {t && t !== "running" && t.ok && (
                      <span className="muted">OK · {t.modelCount} models · {t.latencyMs}ms</span>
                    )}
                    {t && t !== "running" && !t.ok && (
                      <span className="muted error">fail: {t.error}</span>
                    )}
                  </td>
                  <td>
                    <div className="form-row tight">
                      <button type="button" className="btn small" onClick={() => void runTest(p)}>
                        Test
                      </button>
                      <button type="button" className="btn small" onClick={() => void toggleEnabled(p)}>
                        {p.enabled ? "Disable" : "Enable"}
                      </button>
                      <button type="button" className="btn small" onClick={() => void remove(p)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!loading && providers.length === 0 && (
        <p className="muted small">No providers yet. Click "Add provider" to wire up DeepSeek, Ollama, or any OpenAI-compatible endpoint.</p>
      )}

      {showWizard && (
        <AddProviderWizard
          onClose={() => setShowWizard(false)}
          onCreated={() => {
            setShowWizard(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function AddProviderWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<ProviderKind>("deepseek");
  const preset = PROVIDER_PRESETS[kind];
  const [name, setName] = useState<string>(PROVIDER_KIND_LABEL[kind]);
  const [baseUrl, setBaseUrl] = useState<string>(preset.baseUrl ?? "");
  const [apiKey, setApiKey] = useState<string>("");
  const [defaultModel, setDefaultModel] = useState<string>(preset.defaultModel ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testInline, setTestInline] = useState<TestResult | null>(null);

  useEffect(() => {
    const p = PROVIDER_PRESETS[kind];
    setName(PROVIDER_KIND_LABEL[kind]);
    setBaseUrl(p.baseUrl ?? "");
    setDefaultModel(p.defaultModel ?? "");
    setTestInline(null);
    setErr(null);
  }, [kind]);

  const keyRequired = kind !== "ollama" && kind !== "openai-compatible";

  const submit = async (testAfter: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { kind, name };
      if (baseUrl) body["baseUrl"] = baseUrl;
      if (apiKey) body["apiKey"] = apiKey;
      if (defaultModel) body["defaultModel"] = defaultModel;
      const r = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as ProviderRow & { error?: string };
      if (!r.ok || data.error) {
        setErr(data.error ?? r.statusText);
        return;
      }
      if (testAfter) {
        const t = await testProvider(data.id);
        setTestInline(t);
        if (!t.ok) {
          // Created but test failed — let user decide whether to keep it.
          return;
        }
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !busy && name.length > 0 && (!keyRequired || apiKey.length > 0);

  return (
    <div className="card card-wide-input">
      <h3 className="section-title section-title-no-mt">Add provider</h3>

      <div className="form-row">
        <label className="form-label">Kind</label>
        <select
          className="form-input form-input-inline"
          value={kind}
          onChange={(e) => setKind(e.target.value as ProviderKind)}
          disabled={busy}
        >
          {PROVIDER_KINDS.map((k) => (
            <option key={k} value={k}>{PROVIDER_KIND_LABEL[k]}</option>
          ))}
        </select>
        <label className="form-label">Name</label>
        <input
          className="form-input form-input-inline"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Display name (must be unique)"
          disabled={busy}
        />
      </div>

      <div className="form-row">
        <label className="form-label">Base URL</label>
        <input
          className="form-input form-input-inline"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={kind === "openai-compatible" ? "https://your-endpoint/v1" : ""}
          disabled={busy}
        />
      </div>

      <div className="form-row">
        <label className="form-label">API key{keyRequired ? "" : " (optional)"}</label>
        <input
          type="password"
          className="form-input form-input-inline"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          disabled={busy}
        />
      </div>

      <div className="form-row">
        <label className="form-label">Default model</label>
        <input
          className="form-input form-input-inline"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          placeholder="optional"
          disabled={busy}
        />
      </div>

      {testInline && !testInline.ok && (
        <p className="form-error">
          Saved, but test failed: {testInline.error} ({testInline.latencyMs}ms). You can edit or delete from the list.
        </p>
      )}
      {err && <p className="form-error">{err}</p>}

      <div className="form-row">
        <button type="button" className="btn btn-accent" onClick={() => void submit(true)} disabled={!canSubmit}>
          {busy ? "Saving…" : "Save & test"}
        </button>
        <button type="button" className="btn" onClick={() => void submit(false)} disabled={!canSubmit}>
          Save without testing
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
