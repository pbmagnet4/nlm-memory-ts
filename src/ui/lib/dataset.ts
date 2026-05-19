/**
 * Dataset hook + types. /api/dataset is the single read backbone for pulse,
 * river, search, and thread. Fetched once on mount; pages compose against
 * the cached result. Optional polling for live refresh.
 */

import { useEffect, useState } from "react";

export interface DatasetSession {
  id: string;
  date: string;
  started_at: string | null;
  ended_at: string | null;
  label: string;
  summary: string;
  entities: string[];
  decisions: string[];
  open: string[];
  open_questions: { id: string; text: string; resolved: boolean }[];
  status: "active" | "idle" | "closed" | "superseded";
  duration_min: number;
  runtime: string;
  supersedes?: string;
  superseded_by?: string;
}

export interface DatasetEntity {
  canonical: string;
  type: string;
  status: string;
  session_count: number;
  last_seen_session: string | null;
}

export interface DatasetAlert {
  id: string;
  type: "stale";
  severity: "high" | "medium";
  entity: string;
  summary: string;
  sessions: string[];
}

export interface Dataset {
  meta: {
    last_sync: string;
    sessions_total: number;
    entities_total: number;
    db_present: boolean;
    db_path: string;
  };
  sessions: DatasetSession[];
  entities: DatasetEntity[];
  entity_colors: Record<string, string>;
  entity_type: Record<string, string>;
  entity_status: Record<string, string>;
  metrics: {
    this_week: number;
    last_week: number;
    sparkline: number[];
    healthy: number;
    sparse: number;
    stale: number;
    closed_decisions: number;
  };
  alerts: DatasetAlert[];
}

export interface DatasetState {
  data: Dataset | null;
  loading: boolean;
  error: string | null;
}

export function useDataset(pollMs?: number): DatasetState {
  const [state, setState] = useState<DatasetState>({ data: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/dataset");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Dataset;
        if (!cancelled) setState({ data, loading: false, error: null });
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setState((prev) => ({ data: prev.data, loading: false, error: msg }));
        }
      }
    };
    void load();
    if (pollMs && pollMs > 0) {
      const id = setInterval(load, pollMs);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [pollMs]);
  return state;
}

export function relativeAge(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d";
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}
