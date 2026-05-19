import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SideNav } from "./components/SideNav.js";
import { LivePage } from "./pages/Live.js";
import { StubPage } from "./pages/Stub.js";

export function App() {
  return (
    <div className="page-shell">
      <SideNav />
      <div className="page-main">
        <AppHeader />
        <Routes>
          <Route path="/" element={<Navigate to="/live" replace />} />
          <Route path="/live"               element={<LivePage />} />
          <Route path="/pulse"              element={<StubPage page="pulse" />} />
          <Route path="/river"              element={<StubPage page="river" />} />
          <Route path="/thread"             element={<StubPage page="thread" />} />
          <Route path="/search"             element={<StubPage page="search" />} />
          <Route path="/settings"           element={<StubPage page="settings" />} />
          <Route path="/settings/labels"    element={<StubPage page="settings/labels" />} />
          <Route path="/settings/classifier" element={<StubPage page="settings/classifier" />} />
          <Route path="/settings/data"      element={<StubPage page="settings/data" />} />
          <Route path="/settings/views"     element={<StubPage page="settings/views" />} />
          <Route path="*"                   element={<StubPage page="not found" />} />
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
