/**
 * Build the deterministic "Known failure modes" block injected at session
 * start. No LLM on this path - it runs inside the SessionStart hook's ~2s
 * budget. Threshold-gated via the aggregator.
 */

import type { SignalStore } from "@ports/signal-store.js";
import { aggregateFailureModes, type AggregateOptions, type FailureMode } from "./aggregate.js";

export interface FailureModeRecallOptions extends AggregateOptions {
  readonly windowDays?: number;
  readonly maxModes?: number;
}

export function renderFailureMode(mode: FailureMode, windowDays: number): string {
  const pct = Math.round(mode.failRate * 100);
  const where = mode.step ? `\`${mode.step}\`` : mode.kind;
  return `- ${mode.model} failed ${where} on ${pct}% of ${mode.kind} checks in this repo (n=${mode.total}, ${windowDays}d).`;
}

export async function buildFailureModeBlock(
  store: SignalStore,
  args: { installScope: string; repo: string; model?: string; now?: () => Date },
  opts: FailureModeRecallOptions = {},
): Promise<string> {
  const windowDays = opts.windowDays ?? 14;
  const maxModes = opts.maxModes ?? 3;
  const now = (args.now ?? (() => new Date()))();
  const sinceTs = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

  const signals = await store.listForAggregation({
    installScope: args.installScope,
    repo: args.repo,
    ...(args.model ? { model: args.model } : {}),
    sinceTs,
  });

  const modes = aggregateFailureModes(signals, opts).slice(0, maxModes);
  if (modes.length === 0) return "";

  return ["## Known failure modes for this repo", ...modes.map((m) => renderFailureMode(m, windowDays))].join("\n");
}
