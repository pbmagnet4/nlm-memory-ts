import { useEffect, useState } from "react";

export interface RecentRead {
  ts: string;
  source: string;
  /** Calling agent runtime if set via x-recall-runtime; null on legacy / unknown. */
  runtime: string | null;
  query: string | null;
  mode: string;
  nResults: number;
}

export interface RecentWrite {
  id: string;
  runtime: string;
  label: string;
  summary: string;
  createdAt: string;
  /** Top entities (topics) associated with the session. Empty if none yet. */
  entities: string[];
}

export interface RecentMarker {
  sessionId: string;
  kind: "decision" | "open";
  text: string;
  label: string;
  createdAt: string;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export interface PolledResult<T> {
  /** Most recent successful payload, or `initial` until the first fetch lands. */
  data: T;
  /** Message from the latest failed tick; cleared on the next success. */
  error: string | null;
  /** Epoch ms of the last successful fetch, or null before the first. */
  lastUpdated: number | null;
  /** True until the first tick resolves (success or failure). */
  loading: boolean;
}

export function usePolledEndpoint<T>(path: string, intervalMs: number, initial: T): PolledResult<T> {
  const [state, setState] = useState<PolledResult<T>>({
    data: initial,
    error: null,
    lastUpdated: null,
    loading: true,
  });
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await fetchJson<T>(path);
        if (!cancelled) {
          setState({ data: next, error: null, lastUpdated: Date.now(), loading: false });
        }
      } catch (e) {
        // Keep prior data on transient failure; surface the error so the
        // UI can flag staleness. The next tick retries.
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            error: e instanceof Error ? e.message : String(e),
            loading: false,
          }));
        }
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [path, intervalMs]);
  return state;
}

export interface UiFailureMode {
  repo: string;
  model: string;
  kind: string;
  step: string | null;
  total: number;
  failures: number;
  failRate: number;
  lastTs: string;
}

export interface FailureModeStats {
  days: number;
  total: number;
  modes: UiFailureMode[];
}

export async function fetchFailureModeStats(days = 14): Promise<FailureModeStats> {
  const res = await fetch(`/api/signals/stats?days=${days}`);
  if (!res.ok) throw new Error(`/api/signals/stats → ${res.status}`);
  return res.json() as Promise<FailureModeStats>;
}

export function relativeTime(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
