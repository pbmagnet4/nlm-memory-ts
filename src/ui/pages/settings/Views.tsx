import { useEffect, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";

type ViewSettings = {
  landing: "live" | "pulse" | "river" | "thread" | "search";
  riverDensity: "compact" | "comfortable" | "spacious";
  threadSort: "recent" | "oldest";
};

const KEY = "nle.settings.views";
const DEFAULT: ViewSettings = { landing: "live", riverDensity: "comfortable", threadSort: "recent" };

function read(): ViewSettings {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    return { ...DEFAULT, ...(JSON.parse(raw) as Partial<ViewSettings>) };
  } catch {
    return DEFAULT;
  }
}

export function SettingsViewsPage() {
  const [values, setValues] = useState<ViewSettings>(DEFAULT);
  useEffect(() => setValues(read()), []);
  useEffect(() => {
    window.localStorage.setItem(KEY, JSON.stringify(values));
  }, [values]);

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <h2 className="page-title">Views</h2>
      <div className="form-grid">
        <Field label="Default landing">
          <select className="form-input" value={values.landing} onChange={(e) => setValues({ ...values, landing: e.target.value as ViewSettings["landing"] })}>
            <option value="live">Live</option>
            <option value="pulse">Pulse</option>
            <option value="river">River</option>
            <option value="search">Search</option>
          </select>
        </Field>
        <Field label="River density">
          <select className="form-input" value={values.riverDensity} onChange={(e) => setValues({ ...values, riverDensity: e.target.value as ViewSettings["riverDensity"] })}>
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
            <option value="spacious">Spacious</option>
          </select>
        </Field>
        <Field label="Thread sort">
          <select className="form-input" value={values.threadSort} onChange={(e) => setValues({ ...values, threadSort: e.target.value as ViewSettings["threadSort"] })}>
            <option value="recent">Most recent first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </Field>
      </div>
      <p className="muted small">Preferences are stored in localStorage and read by consumer pages.</p>
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
