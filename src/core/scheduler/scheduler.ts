/**
 * ScanScheduler — periodic ingest loop. Ports `scheduler.py`.
 *
 * Each tick walks the registered adapters, runs scanOnce to discover idle
 * transcript files, classifies the resulting SessionChunks via the active
 * classifier, and persists them through SqliteSessionStore.insertSession
 * with the embedder. Records adapter_state after each successful insert
 * so the next tick is incremental.
 *
 * Single-process: the scheduler runs alongside the HTTP server (Phase D
 * wires it into `nlm start`). No worker thread; Node's event loop is
 * enough — adapter discovery is filesystem-bound and the per-chunk
 * classify call is async-awaited with a wall-clock timeout to keep the
 * tick loop responsive.
 *
 * Confidence floor of 0.3 mirrors Python: classifier outputs below that
 * are skipped rather than persisted as low-quality noise.
 */

import type { LLMClient } from "@ports/llm-client.js";
import type { TranscriptAdapter } from "@ports/transcript-adapter.js";
import type { SignalStore } from "@ports/signal-store.js";
import { extractFacts } from "@core/facts/extract-facts.js";
import { normalizeSignal } from "@core/signals/ingest-signal.js";
import type { SqliteFactStore } from "@core/storage/sqlite-fact-store.js";
import type {
  IngestRecord,
  SqliteSessionStore,
} from "@core/storage/sqlite-session-store.js";
import type { Signal } from "@shared/types.js";
import { MAX_CLASSIFY_FAILURES, getFileSize, recordClassified, recordFailed, recordFailedPg, scanOnce, scanOncePg } from "./scan-once.js";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 min, matches Python default
const DEFAULT_CLASSIFY_TIMEOUT_MS = 120_000;
const DEFAULT_CONFIDENCE_FLOOR = 0.3;
const DEFAULT_IDLE_MINUTES = 15;
const BODY_CAP = 200_000;

export interface SchedulerOptions {
  readonly store: SqliteSessionStore;
  readonly adapters: ReadonlyArray<TranscriptAdapter>;
  readonly classifier: LLMClient;
  readonly embedder?: LLMClient | null;
  /**
   * FactStore for Phase B.2 fact ingest. When provided, the scheduler
   * extracts facts from each classify result and persists them atomically
   * with the session row. Optional — when null, sessions ingest as before
   * with no facts written (backwards-compatible default for tests not yet
   * updated, and for any future caller that wants facts off).
   */
  readonly factStore?: SqliteFactStore | null;
  /** SignalStore for the self-improvement lane. When set, the tick drains
   *  each chunk's embedded nlm.signal payloads, decoupled from classification. */
  readonly signalStore?: SignalStore | null;
  /** Per-install scope stamped on drained signals. Required when signalStore is set. */
  readonly installScope?: string;
  readonly intervalMs?: number;
  readonly classifyTimeoutMs?: number;
  readonly confidenceFloor?: number;
  readonly idleMinutes?: number;
  /** Defaults to console.error. Set to a noop in tests. */
  readonly logger?: (msg: string) => void;
}

export interface TickReport {
  readonly inserted: number;
  readonly skippedLowConfidence: number;
  readonly classifyFailures: number;
  readonly storageFailures: number;
  readonly chunksSeen: number;
}

export class ScanScheduler {
  private readonly opts: Required<Omit<SchedulerOptions, "embedder" | "factStore" | "signalStore" | "installScope">> & {
    readonly embedder: LLMClient | null;
    readonly factStore: SqliteFactStore | null;
    readonly signalStore: SignalStore | null;
    readonly installScope: string;
  };
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: SchedulerOptions) {
    this.opts = {
      store: opts.store,
      adapters: opts.adapters,
      classifier: opts.classifier,
      embedder: opts.embedder ?? null,
      factStore: opts.factStore ?? null,
      signalStore: opts.signalStore ?? null,
      installScope: opts.installScope ?? "default",
      intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
      classifyTimeoutMs: opts.classifyTimeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS,
      confidenceFloor: opts.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR,
      idleMinutes: opts.idleMinutes ?? DEFAULT_IDLE_MINUTES,
      logger: opts.logger ?? ((msg) => console.error(msg)),
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext(this.opts.intervalMs));
    }, delayMs);
  }

  async tick(): Promise<TickReport> {
    let inserted = 0;
    let skippedLowConfidence = 0;
    let classifyFailures = 0;
    let storageFailures = 0;
    let chunksSeen = 0;

    for (const adapter of this.opts.adapters) {
      const _pgPool = (this.opts.store as { pgPool?: () => import("pg").Pool }).pgPool?.();
      let results;
      try {
        results = _pgPool
          ? await scanOncePg(adapter, this.opts.idleMinutes, _pgPool)
          : await scanOnce(adapter, this.opts.idleMinutes, this.opts.store.rawDb());
      } catch (e) {
        this.opts.logger(
          `[scheduler] scanOnce error for ${adapter.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      for (const { chunk, supersedes } of results) {
        chunksSeen += 1;
        await this.drainSignals(chunk);

        let classification;
        try {
          classification = await withTimeout(
            this.opts.classifier.classify(chunk.text),
            this.opts.classifyTimeoutMs,
          );
        } catch (e) {
          classifyFailures += 1;
          const reason = e instanceof TimeoutError ? "timed out" : `error: ${e instanceof Error ? e.message : String(e)}`;
          if (_pgPool) {
            void recordFailedPg(_pgPool, adapter.name, chunk.sourcePath, getFileSize(chunk.sourcePath));
          } else {
            recordFailed(this.opts.store.rawDb(), adapter.name, chunk.sourcePath);
          }
          const count = _pgPool
            ? 1
            : (this.opts.store.rawDb()
                .prepare<[string, string], { failure_count: number }>(
                  "SELECT COALESCE(failure_count, 0) AS failure_count FROM adapter_state WHERE adapter_name = ? AND source_path = ?",
                )
                .get(adapter.name, chunk.sourcePath)?.failure_count ?? 1);
          const ceiling = count >= MAX_CLASSIFY_FAILURES ? ` (failure ${count}/${MAX_CLASSIFY_FAILURES} — will skip until file grows)` : ` (failure ${count}/${MAX_CLASSIFY_FAILURES})`;
          this.opts.logger(`[scheduler] classifier ${reason} for ${chunk.id}${ceiling}`);
          continue;
        }

        if (classification.confidence < this.opts.confidenceFloor) {
          skippedLowConfidence += 1;
          continue;
        }

        const record: IngestRecord = {
          id: chunk.id,
          runtime: chunk.runtime,
          runtimeSessionId: chunk.runtimeSessionId || null,
          startedAt: chunk.startedAt,
          endedAt: chunk.endedAt || null,
          durationMin: chunk.durationMin,
          label: classification.label,
          summary: classification.summary,
          body: chunk.text.slice(0, BODY_CAP),
          status: "closed",
          transcriptKind: adapter.transcriptKind,
          transcriptPath: chunk.sourcePath,
          transcriptOffset: chunk.byteRange[0],
          transcriptLength: chunk.byteRange[1],
          entities: classification.entities,
          decisions: classification.decisions,
          openQuestions: classification.open,
        };

        const factSink = this.opts.factStore
          ? {
              factStore: this.opts.factStore,
              facts: extractFacts(classification, chunk.id, chunk.startedAt),
            }
          : null;

        try {
          await this.opts.store.insertSession(
            record,
            this.opts.embedder,
            supersedes,
            factSink,
          );
          if (!_pgPool) {
            recordClassified(
              this.opts.store.rawDb(),
              adapter.name,
              chunk.sourcePath,
              chunk.id,
            );
          }
          inserted += 1;
        } catch (e) {
          storageFailures += 1;
          if (_pgPool) {
            void recordFailedPg(_pgPool, adapter.name, chunk.sourcePath, getFileSize(chunk.sourcePath));
          } else {
            recordFailed(this.opts.store.rawDb(), adapter.name, chunk.sourcePath);
          }
          this.opts.logger(
            `[scheduler] storage error for ${chunk.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    return { inserted, skippedLowConfidence, classifyFailures, storageFailures, chunksSeen };
  }

  private async drainSignals(chunk: { id: string; signals?: ReadonlyArray<unknown> }): Promise<void> {
    if (process.env["NLM_SIGNALS_ENABLED"] === "0") return;
    if (!this.opts.signalStore || !chunk.signals?.length) return;
    try {
      const normalized: Signal[] = [];
      for (const raw of chunk.signals) {
        try {
          normalized.push(normalizeSignal(raw, this.opts.installScope));
        } catch {
          // skip a malformed embedded signal; one bad entry must not lose the rest
        }
      }
      if (normalized.length > 0) await this.opts.signalStore.insertMany(normalized);
    } catch (e) {
      this.opts.logger(
        `[scheduler] signal drain failed for ${chunk.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

class TimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
