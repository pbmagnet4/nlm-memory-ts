/**
 * Skeleton — shape-matched placeholders for first-load states.
 *
 * Only used where the shape is known + the data fetch is slow enough that
 * the page reflowing from "Loading…" to populated is jarring. Cached
 * refetches reuse stale data; they never show a skeleton.
 */

export function Skeleton({
  w,
  h = 12,
  radius = 4,
  className,
}: {
  w?: number | string;
  h?: number | string;
  radius?: number;
  className?: string;
}) {
  const style: React.CSSProperties = {
    width: typeof w === "number" ? `${w}px` : w ?? "100%",
    height: typeof h === "number" ? `${h}px` : h,
    borderRadius: radius,
  };
  return <span className={`skeleton${className ? ` ${className}` : ""}`} style={style} aria-hidden="true" />;
}

export function PulseSkeleton() {
  const areas = ["pulse-area-coherence", "pulse-area-runtimes", "pulse-area-recent", "pulse-area-stale"] as const;
  return (
    <div className="page-pad">
      <div className="kpi-row">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="kpi">
            <Skeleton h={10} w={70} />
            <Skeleton h={28} w={90} />
            <Skeleton h={10} w={60} />
          </div>
        ))}
        <div className="kpi"><Skeleton h={56} /></div>
      </div>
      <div className="pulse-grid">
        {areas.map((area, i) => (
          <section key={area} className={`card pulse-scroll-card ${area}`}>
            <header className="card-head"><Skeleton h={14} w={140} /></header>
            <div className="pulse-scroll-body">
              <ul className="session-list">
                {Array.from({ length: 5 }).map((_, j) => (
                  <li key={j} className="session-row">
                    <Skeleton h={14} w={48} radius={10} />
                    <Skeleton h={12} w={`${50 + ((i + j) * 11) % 35}%`} />
                    <Skeleton h={10} w={40} />
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function SessionListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="session-list">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="session-row session-row-detail">
          <Skeleton h={18} w={56} radius={10} />
          <div className="session-row-main">
            <Skeleton h={13} w={`${50 + ((i * 11) % 35)}%`} />
            <Skeleton h={11} w={`${30 + ((i * 13) % 50)}%`} />
          </div>
          <Skeleton h={10} w={48} />
        </li>
      ))}
    </ul>
  );
}

export function TableRowSkeleton({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j}><Skeleton h={12} w={j === 0 ? "70%" : j === cols - 1 ? "60%" : "50%"} /></td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

export function SessionDrawerSkeleton() {
  return (
    <div className="drawer-body">
      <dl className="kv-list">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton-display-contents">
            <dt className="kv-label"><Skeleton h={10} w={70} /></dt>
            <dd className="kv-value"><Skeleton h={12} w={`${40 + ((i * 13) % 50)}%`} /></dd>
          </div>
        ))}
      </dl>
      <h4 className="drawer-section"><Skeleton h={12} w={100} /></h4>
      <div className="skeleton-column-gap">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} h={12} w={`${55 + ((i * 7) % 35)}%`} />
        ))}
      </div>
    </div>
  );
}
