/**
 * Dataset hook + types. /api/dataset is the single read backbone for pulse,
 * river, search, and thread. Fetched once on mount; pages compose against
 * the cached result. Optional polling for live refresh.
 */

import { useCallback, useEffect, useRef, useState } from "react";

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
  /** Renamed display label from the action overlay; absent if not renamed. */
  display?: string;
}

export interface DatasetAlert {
  id: string;
  type: "stale";
  severity: "high" | "medium";
  entity: string;
  summary: string;
  sessions: string[];
  age_days: number;
  last_touch_at: string | null;
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
  /** canonical → display label; only canonicals with an active rename are present. */
  entity_display: Record<string, string>;
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
  runtimes: DatasetRuntime[];
}

export interface DatasetRuntime {
  name: string;
  status: "active" | "idle" | "dormant";
  sessions_total: number;
  this_week: number;
  last_week: number;
  last_session_at: string | null;
}

export interface DatasetState {
  data: Dataset | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

interface DatasetInternal {
  data: Dataset | null;
  loading: boolean;
  error: string | null;
}

export function useDataset(pollMs?: number): DatasetState {
  const [state, setState] = useState<DatasetInternal>({ data: null, loading: true, error: null });
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dataset");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Dataset;
      if (!cancelledRef.current) setState({ data, loading: false, error: null });
    } catch (e) {
      if (!cancelledRef.current) {
        const msg = e instanceof Error ? e.message : String(e);
        setState((prev) => ({ data: prev.data, loading: false, error: msg }));
      }
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    if (pollMs && pollMs > 0) {
      const id = setInterval(load, pollMs);
      return () => {
        cancelledRef.current = true;
        clearInterval(id);
      };
    }
    return () => {
      cancelledRef.current = true;
    };
  }, [pollMs, load]);

  return { ...state, refetch: load };
}

/**
 * Resolve a topic's display label from the canonical storage key. Renames
 * land in data.entity_display via the action overlay; absent means no rename
 * and the canonical doubles as the label.
 */
export function topicDisplay(data: Dataset | null | undefined, canonical: string): string {
  if (!data) return canonical;
  return data.entity_display[canonical] ?? canonical;
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
