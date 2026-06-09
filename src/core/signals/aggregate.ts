/**
 * Pure roll-up of signals into threshold-gated failure modes. No I/O, no LLM
 * (LLM polish lives in the UI / `nlm improve` layer only). The caller passes a
 * pre-filtered, pre-windowed slice from the SignalStore.
 */

import type { Signal } from "@shared/types.js";

export interface FailureMode {
  readonly repo: string;
  readonly model: string;
  readonly kind: string;
  readonly step: string | null;
  readonly total: number;
  readonly failures: number;
  readonly failRate: number;
  readonly lastTs: string;
}

export interface AggregateOptions {
  readonly minFailRate?: number;
  readonly minSamples?: number;
}

const FAILING: ReadonlySet<string> = new Set(["fail", "exhausted"]);

export function aggregateFailureModes(
  signals: ReadonlyArray<Signal>,
  opts: AggregateOptions = {},
): ReadonlyArray<FailureMode> {
  const minFailRate = opts.minFailRate ?? 0.2;
  const minSamples = opts.minSamples ?? 10;

  type Bucket = { repo: string; model: string; kind: string; step: string | null; total: number; failures: number; lastTs: string };
  const buckets = new Map<string, Bucket>();

  for (const s of signals) {
    const key = [s.repo, s.model, s.kind, s.step ?? ""].join(" ");
    let b = buckets.get(key);
    if (!b) {
      b = { repo: s.repo, model: s.model, kind: s.kind, step: s.step, total: 0, failures: 0, lastTs: s.ts };
      buckets.set(key, b);
    }
    b.total += 1;
    if (FAILING.has(s.outcome)) b.failures += 1;
    if (s.ts > b.lastTs) b.lastTs = s.ts;
  }

  const modes: FailureMode[] = [];
  for (const b of buckets.values()) {
    const failRate = b.total === 0 ? 0 : b.failures / b.total;
    if (b.total >= minSamples && failRate >= minFailRate) {
      modes.push({ repo: b.repo, model: b.model, kind: b.kind, step: b.step, total: b.total, failures: b.failures, failRate, lastTs: b.lastTs });
    }
  }
  modes.sort((a, b) => b.failRate - a.failRate || b.total - a.total);
  return modes;
}
