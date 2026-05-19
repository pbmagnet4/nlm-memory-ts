/**
 * backfill-facts — one-shot population of the FactStore from the existing
 * session corpus. Phase B.5, see docs/plans/factstore-design.md Section 7.
 *
 * For each session in `sessions` that has no facts yet (and was started
 * before the script's start timestamp, to avoid racing with live ingest),
 * runs the classifier over its body, extracts facts, and writes them via
 * SqliteSessionStore.insertFactsForSession.
 *
 * Resumable via a JSON state file (mirrors core/embedding/embed-backfill).
 * Interrupting and rerunning skips already-processed sessions. State path
 * defaults to ~/.nle/backfill_facts.state.
 *
 * Layering: depends on the LLMClient + FactStore ports through the
 * SqliteSessionStore + SqliteFactStore composition. Lives under core/ but
 * is invoked from the CLI composition root, like embed-backfill.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { extractFacts } from "@core/facts/extract-facts.js";
import type { SqliteFactStore } from "@core/storage/sqlite-fact-store.js";
import type { SqliteSessionStore } from "@core/storage/sqlite-session-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";

const DEFAULT_STATE_PATH = join(homedir(), ".nle", "backfill_facts.state");
const SAVE_EVERY = 25;

export interface BackfillFactsOptions {
  readonly store: SqliteSessionStore;
  readonly factStore: SqliteFactStore;
  readonly classifier: LLMClient;
  /** Optional embedder. When omitted, facts are written without semantic vectors. */
  readonly embedder?: LLMClient | null;
  readonly statePath?: string;
  /** Cap on sessions processed this run. Default: all eligible. */
  readonly limit?: number;
  /**
   * Resume from a specific session id. When set, sessions with id
   * lexicographically <= this value are skipped on top of the state file's
   * done set. Useful when the state file is lost but the operator
   * remembers the last successful id.
   */
  readonly from?: string;
  /** Don't write — just count what would happen. */
  readonly dryRun?: boolean;
  /**
   * Re-process sessions that already have facts. Default: false (skip).
   * Use when iterating the classifier prompt to refresh the corpus.
   */
  readonly reprocess?: boolean;
  readonly onProgress?: (
    i: number,
    total: number,
    sessionId: string,
    status: BackfillStatus,
    details?: string,
  ) => void;
}

export type BackfillStatus =
  | "ok"
  | "skipped_done"
  | "skipped_existing_facts"
  | "skipped_no_body"
  | "skipped_low_confidence"
  | "classify_failed"
  | "storage_failed";

export interface BackfillFactsReport {
  readonly total: number;
  readonly processed: number;
  readonly factsWritten: number;
  readonly skippedAlreadyDone: number;
  readonly skippedExistingFacts: number;
  readonly skippedNoBody: number;
  readonly skippedLowConfidence: number;
  readonly classifyFailures: number;
  readonly storageFailures: number;
}

interface CandidateRow {
  id: string;
  started_at: string;
  body: string | null;
}

function loadState(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { done?: string[] };
    return new Set(data.done ?? []);
  } catch {
    return new Set();
  }
}

function saveState(path: string, done: Set<string>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ done: Array.from(done) }, null, 0));
}

export async function backfillFacts(
  opts: BackfillFactsOptions,
): Promise<BackfillFactsReport> {
  const startedAtCutoff = new Date().toISOString();
  const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
  const done = opts.dryRun ? new Set<string>() : loadState(statePath);

  const db = opts.store.rawDb();

  // Eligible sessions: started strictly before this run's cutoff (don't
  // race with live ingest), with a non-empty body (the classifier needs
  // transcript text). When reprocess=false, exclude sessions that already
  // have facts attributed to them.
  const sql = opts.reprocess
    ? `
      SELECT id, started_at, body
      FROM sessions
      WHERE started_at < ?
        AND body IS NOT NULL AND length(body) > 0
        ${opts.from ? "AND id > ?" : ""}
      ORDER BY started_at ASC, id ASC
    `
    : `
      SELECT s.id, s.started_at, s.body
      FROM sessions s
      WHERE s.started_at < ?
        AND s.body IS NOT NULL AND length(s.body) > 0
        AND NOT EXISTS (
          SELECT 1 FROM facts f WHERE f.source_session_id = s.id
        )
        ${opts.from ? "AND s.id > ?" : ""}
      ORDER BY s.started_at ASC, s.id ASC
    `;
  const rows: CandidateRow[] = opts.from
    ? db.prepare<[string, string], CandidateRow>(sql).all(startedAtCutoff, opts.from)
    : db.prepare<[string], CandidateRow>(sql).all(startedAtCutoff);

  const limit = opts.limit ?? rows.length;
  const work = rows.slice(0, limit);
  const total = work.length;

  let processed = 0;
  let factsWritten = 0;
  let skippedAlreadyDone = 0;
  let skippedExistingFacts = 0;
  let skippedNoBody = 0;
  let skippedLowConfidence = 0;
  let classifyFailures = 0;
  let storageFailures = 0;

  for (let i = 0; i < work.length; i++) {
    const row = work[i]!;
    const sid = row.id;

    if (done.has(sid)) {
      skippedAlreadyDone += 1;
      opts.onProgress?.(i + 1, total, sid, "skipped_done");
      continue;
    }

    if (!row.body || row.body.length === 0) {
      skippedNoBody += 1;
      opts.onProgress?.(i + 1, total, sid, "skipped_no_body");
      continue;
    }

    let classification;
    try {
      classification = await opts.classifier.classify(row.body);
    } catch (err) {
      classifyFailures += 1;
      const detail =
        err instanceof LLMUnreachableError
          ? "ollama unreachable — stopping run"
          : err instanceof Error
            ? err.message
            : String(err);
      opts.onProgress?.(i + 1, total, sid, "classify_failed", detail);
      // Ollama-down is fatal: every subsequent classify will fail. Stop
      // here so the operator can fix and resume.
      if (err instanceof LLMUnreachableError) break;
      continue;
    }

    const facts = extractFacts(classification, sid, row.started_at);
    if (facts.length === 0) {
      skippedLowConfidence += 1;
      opts.onProgress?.(
        i + 1,
        total,
        sid,
        "skipped_low_confidence",
        `confidence=${classification.confidence}`,
      );
      // Mark done so a re-run doesn't keep paying the classifier cost on
      // sessions the model can't extract anything from.
      done.add(sid);
      if (!opts.dryRun && processed % SAVE_EVERY === 0) saveState(statePath, done);
      continue;
    }

    if (opts.dryRun) {
      factsWritten += facts.length;
      processed += 1;
      opts.onProgress?.(i + 1, total, sid, "ok", `would-write=${facts.length}`);
      continue;
    }

    try {
      await opts.store.insertFactsForSession(
        sid,
        opts.factStore,
        facts,
        opts.embedder ?? null,
      );
    } catch (err) {
      storageFailures += 1;
      const detail = err instanceof Error ? err.message : String(err);
      opts.onProgress?.(i + 1, total, sid, "storage_failed", detail);
      continue;
    }

    factsWritten += facts.length;
    processed += 1;
    done.add(sid);
    opts.onProgress?.(i + 1, total, sid, "ok", `wrote=${facts.length}`);
    if (processed % SAVE_EVERY === 0) saveState(statePath, done);
  }

  if (!opts.dryRun) saveState(statePath, done);

  return {
    total,
    processed,
    factsWritten,
    skippedAlreadyDone,
    skippedExistingFacts,
    skippedNoBody,
    skippedLowConfidence,
    classifyFailures,
    storageFailures,
  };
}
