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
import { extractFacts } from "../facts/extract-facts.js";
import { MAX_CLASSIFY_FAILURES, recordClassified, recordFailed, scanOnce } from "./scan-once.js";
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 min, matches Python default
const DEFAULT_CLASSIFY_TIMEOUT_MS = 120_000;
const DEFAULT_CONFIDENCE_FLOOR = 0.3;
const DEFAULT_IDLE_MINUTES = 15;
const BODY_CAP = 200_000;
export class ScanScheduler {
    opts;
    stopped = true;
    timer = null;
    constructor(opts) {
        this.opts = {
            store: opts.store,
            adapters: opts.adapters,
            classifier: opts.classifier,
            embedder: opts.embedder ?? null,
            factStore: opts.factStore ?? null,
            intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
            classifyTimeoutMs: opts.classifyTimeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS,
            confidenceFloor: opts.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR,
            idleMinutes: opts.idleMinutes ?? DEFAULT_IDLE_MINUTES,
            logger: opts.logger ?? ((msg) => console.error(msg)),
        };
    }
    start() {
        if (!this.stopped)
            return;
        this.stopped = false;
        this.scheduleNext(0);
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    scheduleNext(delayMs) {
        if (this.stopped)
            return;
        this.timer = setTimeout(() => {
            void this.tick().finally(() => this.scheduleNext(this.opts.intervalMs));
        }, delayMs);
    }
    async tick() {
        let inserted = 0;
        let skippedLowConfidence = 0;
        let classifyFailures = 0;
        let storageFailures = 0;
        let chunksSeen = 0;
        for (const adapter of this.opts.adapters) {
            let results;
            try {
                results = await scanOnce(adapter, this.opts.idleMinutes, this.opts.store.rawDb());
            }
            catch (e) {
                this.opts.logger(`[scheduler] scanOnce error for ${adapter.name}: ${e instanceof Error ? e.message : String(e)}`);
                continue;
            }
            for (const { chunk, supersedes } of results) {
                chunksSeen += 1;
                let classification;
                try {
                    classification = await withTimeout(this.opts.classifier.classify(chunk.text), this.opts.classifyTimeoutMs);
                }
                catch (e) {
                    classifyFailures += 1;
                    const reason = e instanceof TimeoutError ? "timed out" : `error: ${e instanceof Error ? e.message : String(e)}`;
                    recordFailed(this.opts.store.rawDb(), adapter.name, chunk.sourcePath);
                    const failureRow = this.opts.store.rawDb()
                        .prepare("SELECT COALESCE(failure_count, 0) AS failure_count FROM adapter_state WHERE adapter_name = ? AND source_path = ?")
                        .get(adapter.name, chunk.sourcePath);
                    const count = failureRow?.failure_count ?? 1;
                    const ceiling = count >= MAX_CLASSIFY_FAILURES ? ` (failure ${count}/${MAX_CLASSIFY_FAILURES} — will skip until file grows)` : ` (failure ${count}/${MAX_CLASSIFY_FAILURES})`;
                    this.opts.logger(`[scheduler] classifier ${reason} for ${chunk.id}${ceiling}`);
                    continue;
                }
                if (classification.confidence < this.opts.confidenceFloor) {
                    skippedLowConfidence += 1;
                    continue;
                }
                const record = {
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
                    await this.opts.store.insertSession(record, this.opts.embedder, supersedes, factSink);
                    recordClassified(this.opts.store.rawDb(), adapter.name, chunk.sourcePath, chunk.id);
                    inserted += 1;
                }
                catch (e) {
                    storageFailures += 1;
                    recordFailed(this.opts.store.rawDb(), adapter.name, chunk.sourcePath);
                    this.opts.logger(`[scheduler] storage error for ${chunk.id}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }
        return { inserted, skippedLowConfidence, classifyFailures, storageFailures, chunksSeen };
    }
}
class TimeoutError extends Error {
}
async function withTimeout(promise, ms) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=scheduler.js.map