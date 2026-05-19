export function StubPage({ page }: { page: string }) {
  return (
    <div className="stub-shell">
      <span className="stub-name">/{page}</span>
      <p>not yet ported from the Astro UI.</p>
      <p className="stub-hint">Tracked in NocoDB #95 (Vite + React SPA port).</p>
    </div>
  );
}
