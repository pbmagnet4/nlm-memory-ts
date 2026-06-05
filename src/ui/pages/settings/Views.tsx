import { useEffect, useRef, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";
import {
  readViewSettings,
  writeViewSettings,
  VIEW_SETTINGS_DEFAULT,
  type ViewSettings,
} from "../../lib/view-settings.js";

export function SettingsViewsPage() {
  const [values, setValues] = useState<ViewSettings>(() => readViewSettings());
  const [saved, setSaved] = useState(false);
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    writeViewSettings(values);
    setSaved(true);
    const t = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(t);
  }, [values]);

  const isDefault =
    values.landing === VIEW_SETTINGS_DEFAULT.landing &&
    values.riverDensity === VIEW_SETTINGS_DEFAULT.riverDensity &&
    values.threadSort === VIEW_SETTINGS_DEFAULT.threadSort;

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <div className="form-row between">
        <h2 className="page-title">Views</h2>
        {saved && <span className="muted small">Saved</span>}
      </div>
      <div className="form-grid">
        <Field label="Default landing">
          <select
            className="form-input"
            value={values.landing}
            onChange={(e) => setValues({ ...values, landing: e.target.value as ViewSettings["landing"] })}
          >
            <option value="live">Live</option>
            <option value="pulse">Pulse</option>
            <option value="river">River</option>
            <option value="thread">Thread</option>
            <option value="search">Search</option>
          </select>
        </Field>
        <Field label="River density">
          <select
            className="form-input"
            value={values.riverDensity}
            onChange={(e) => setValues({ ...values, riverDensity: e.target.value as ViewSettings["riverDensity"] })}
          >
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
            <option value="spacious">Spacious</option>
          </select>
        </Field>
        <Field label="Thread sort">
          <select
            className="form-input"
            value={values.threadSort}
            onChange={(e) => setValues({ ...values, threadSort: e.target.value as ViewSettings["threadSort"] })}
          >
            <option value="recent">Most recent first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        <button
          type="button"
          className="btn"
          onClick={() => setValues(VIEW_SETTINGS_DEFAULT)}
          disabled={isDefault}
        >Reset to defaults</button>
      </div>
      <p className="muted small">
        Preferences are stored per-device in localStorage. Landing applies on next load; River density and Thread sort apply when you open those pages.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="form-field">
      <span className="form-label">{label}</span>
      {children}
    </label>
  );
}
