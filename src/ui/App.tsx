import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SideNav } from "./components/SideNav.js";
import { LivePage } from "./pages/Live.js";
import { PulsePage } from "./pages/Pulse.js";
import { RiverPage } from "./pages/River.js";
import { SearchPage } from "./pages/Search.js";
import { ThreadPage } from "./pages/Thread.js";
import { RecallPage } from "./pages/Recall.js";
import { SettingsIndexPage } from "./pages/settings/Index.js";
import { SettingsDataPage } from "./pages/settings/Data.js";
import { SettingsViewsPage } from "./pages/settings/Views.js";
import { SettingsLabelsPage } from "./pages/settings/Labels.js";
import { SettingsClassifierPage } from "./pages/settings/Classifier.js";
import { SettingsSourcesPage } from "./pages/settings/Sources.js";
import { SettingsProvidersPage } from "./pages/settings/Providers.js";
import { StubPage } from "./pages/Stub.js";
import { readViewSettings } from "./lib/view-settings.js";

export function App() {
  return (
    <div className="page-shell">
      <SideNav />
      <div className="page-main">
        <AppHeader />
        <Routes>
          <Route path="/" element={<Navigate to={`/${readViewSettings().landing}`} replace />} />
          <Route path="/live"                element={<LivePage />} />
          <Route path="/pulse"               element={<PulsePage />} />
          <Route path="/river"               element={<RiverPage />} />
          <Route path="/thread"              element={<ThreadPage />} />
          <Route path="/search"              element={<SearchPage />} />
          <Route path="/recall"              element={<RecallPage />} />
          <Route path="/settings"            element={<SettingsIndexPage />} />
          <Route path="/settings/sources"    element={<SettingsSourcesPage />} />
          <Route path="/settings/providers"  element={<SettingsProvidersPage />} />
          <Route path="/settings/labels"     element={<SettingsLabelsPage />} />
          <Route path="/settings/classifier" element={<SettingsClassifierPage />} />
          <Route path="/settings/data"       element={<SettingsDataPage />} />
          <Route path="/settings/views"      element={<SettingsViewsPage />} />
          <Route path="*"                    element={<StubPage page="not found" />} />
        </Routes>
      </div>
    </div>
  );
}

function AppHeader() {
  const { pathname } = useLocation();
  const page = pathname.replace(/^\//, "").replace(/\/+$/, "") || "live";
  return (
    <header className="app-header">
      <span className="wordmark-page">{page}</span>
      <span className="header-spacer" />
      <span className="status-dot" aria-hidden="true" />
      <span className="header-info">nle-memory · :3940</span>
    </header>
  );
}
