/**
 * scanOnce — mtime-gated incremental discovery shared by every adapter.
 *
 * The Python codebase bundled this logic into each adapter (`scan_once` +
 * `record_classified` methods). In the TS port the adapter stays a pure
 * parser (TranscriptAdapter port); the mtime check and adapter_state
 * upsert live here, generic over the adapter. Same behavior, less
 * duplication across claude-code / hermes / pi.
 *
 * Contract (per file under adapter.discover()):
 *   - If `now - mtime < idleMinutes * 60s` → still active, skip
 *   - Lookup adapter_state by (adapterName, sourcePath):
 *       no row + file idle                       → NEW: parse + return (chunk, supersedes=null)
 *       row exists, size match, failures < ceil  → UNCHANGED: skip
 *       row exists, size match, failures >= ceil → FAILED_CEILING: skip (log once per session)
 *       row exists, file grew                    → RESUMED: parse + return, reset failure_count
 *   - After successful classify+insert downstream, call `recordClassified`
 *     to upsert adapter_state with the new size + session_id.
 *   - On classify/storage failure, call `recordFailed` to increment failure_count.
 *     When failure_count reaches MAX_CLASSIFY_FAILURES and the file hasn't grown,
 *     the file is permanently skipped until new content arrives.
 */

import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Pool } from "pg";
import type {
  SessionChunk,
  TranscriptAdapter,
} from "@ports/transcript-adapter.js";

export interface ScanResult {
  readonly chunk: SessionChunk;
  readonly supersedes: string | null;
}

export const MAX_CLASSIFY_FAILURES = 3;

interface AdapterStateRow {
  source_path: string;
  file_size: number | null;
  session_id: string | null;
  failure_count: number;
}

export async function scanOnce(
  adapter: TranscriptAdapter,
  idleMinutes: number,
  db: Database.Database,
  now: number = Date.now(),
): Promise<ReadonlyArray<ScanResult>> {
  const idleMs = idleMinutes * 60 * 1000;
  const stateRows = db
    .prepare<[string], AdapterStateRow>(
      "SELECT source_path, file_size, session_id, COALESCE(failure_count, 0) AS failure_count FROM adapter_state WHERE adapter_name = ?",
    )
    .all(adapter.name);
  const byPath = new Map<string, AdapterStateRow>(stateRows.map((r) => [r.source_path, r]));

  const out: ScanResult[] = [];
  const files = await adapter.discover();

  for (const path of files) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const age = now - st.mtimeMs;
    if (age < idleMs) continue;

    const prior = byPath.get(path);
    if (prior) {
      const sizeUnchanged = (prior.file_size ?? 0) === st.size;
      if (sizeUnchanged) {
        // File hasn't grown — skip whether clean or failed. Failures only
        // retry when the transcript file receives new content.
        continue;
      }
      // File grew: reset failure_count so resume gets a clean slate.
      if (prior.failure_count >= MAX_CLASSIFY_FAILURES) {
        db.prepare(
          "UPDATE adapter_state SET failure_count = 0 WHERE adapter_name = ? AND source_path = ?",
        ).run(adapter.name, path);
      }
    }

    const chunk = await adapter.parseSession(path);
    if (!chunk) continue;
    const supersedes =
      prior?.session_id && prior.session_id !== chunk.id ? prior.session_id : null;
    out.push({ chunk, supersedes });
  }
  return out;
}

export function recordClassified(
  db: Database.Database,
  adapterName: string,
  sourcePath: string,
  sessionId: string,
): void {
  let size = 0;
  try {
    size = statSync(sourcePath).size;
  } catch {
    return;
  }
  db.prepare(
    `INSERT INTO adapter_state
       (adapter_name, source_path, last_offset, file_size, session_id, failure_count, last_processed_at)
     VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
     ON CONFLICT(adapter_name, source_path) DO UPDATE SET
       last_offset = excluded.last_offset,
       file_size = excluded.file_size,
       session_id = excluded.session_id,
       failure_count = 0,
       last_processed_at = excluded.last_processed_at`,
  ).run(adapterName, sourcePath, size, size, sessionId);
}

export function recordFailed(
  db: Database.Database,
  adapterName: string,
  sourcePath: string,
): void {
  let size = 0;
  try {
    size = statSync(sourcePath).size;
  } catch {
    return;
  }
  db.prepare(
    `INSERT INTO adapter_state
       (adapter_name, source_path, last_offset, file_size, session_id, failure_count, last_processed_at)
     VALUES (?, ?, ?, ?, NULL, 1, datetime('now'))
     ON CONFLICT(adapter_name, source_path) DO UPDATE SET
       file_size = excluded.file_size,
       failure_count = failure_count + 1,
       last_processed_at = excluded.last_processed_at`,
  ).run(adapterName, sourcePath, size, size);
}

export function getFileSize(sourcePath: string): number | null {
  try {
    return statSync(sourcePath).size;
  } catch {
    return null;
  }
}

export async function scanOncePg(
  adapter: TranscriptAdapter,
  idleMinutes: number,
  pool: Pool,
  now: number = Date.now(),
): Promise<ScanResult[]> {
  const idleMs = idleMinutes * 60 * 1000;
  const stateRows = await pool.query<{
    source_path: string;
    file_size: string | null;
    session_id: string | null;
    failure_count: number;
  }>(
    `SELECT source_path, file_size, session_id, COALESCE(failure_count, 0) AS failure_count
     FROM adapter_state WHERE adapter_name = $1`,
    [adapter.name],
  );
  // pg returns BIGINT (file_size) as a string; coerce to number so the
  // unchanged-size check compares against statSync's numeric size.
  const stateMap = new Map(
    stateRows.rows.map((r) => [
      r.source_path,
      {
        fileSize: r.file_size === null ? null : Number(r.file_size),
        sessionId: r.session_id,
        failureCount: r.failure_count,
      },
    ]),
  );

  const paths = await adapter.discover();
  const results: ScanResult[] = [];

  for (const sourcePath of paths) {
    // Bug 1 fix: mtime gate — skip files still being written
    let st;
    try {
      st = statSync(sourcePath);
    } catch {
      continue;
    }
    if (now - st.mtimeMs < idleMs) continue;

    const state = stateMap.get(sourcePath);

    // Bug 2 fix: skip unchanged files for ALL paths, not just failure-ceiling paths
    if (state?.fileSize !== undefined && state.fileSize !== null) {
      const currentSize = getFileSize(sourcePath);
      if (currentSize === state.fileSize) continue;
    }

    if (state && state.failureCount >= MAX_CLASSIFY_FAILURES) {
      // File has grown (we didn't continue above), reset failure count
      await pool.query(
        "UPDATE adapter_state SET failure_count = 0 WHERE adapter_name = $1 AND source_path = $2",
        [adapter.name, sourcePath],
      );
    }

    const chunk = await adapter.parseSession(sourcePath);
    if (!chunk) continue;

    const supersedes =
      state?.sessionId && state.sessionId !== chunk.id ? state.sessionId : null;
    results.push({ chunk, supersedes });
  }

  return results;
}

export async function recordClassifiedPg(
  pool: Pool,
  adapterName: string,
  sourcePath: string,
  sessionId: string,
): Promise<void> {
  const size = getFileSize(sourcePath);
  if (size === null) return;
  await pool.query(
    `INSERT INTO adapter_state (adapter_name, source_path, last_offset, file_size, session_id, failure_count, last_processed_at)
     VALUES ($1, $2, 0, $3, $4, 0, NOW())
     ON CONFLICT (adapter_name, source_path) DO UPDATE SET
       file_size = EXCLUDED.file_size,
       session_id = EXCLUDED.session_id,
       failure_count = 0,
       last_processed_at = NOW()`,
    [adapterName, sourcePath, size, sessionId],
  );
}

export async function recordFailedPg(
  pool: Pool,
  adapterName: string,
  sourcePath: string,
  fileSize: number | null,
): Promise<number> {
  const res = await pool.query<{ failure_count: number }>(
    `INSERT INTO adapter_state (adapter_name, source_path, last_offset, failure_count, file_size)
     VALUES ($1, $2, 0, 1, $3)
     ON CONFLICT (adapter_name, source_path) DO UPDATE SET
       failure_count = adapter_state.failure_count + 1,
       file_size = $3,
       last_processed_at = NOW()
     RETURNING failure_count`,
    [adapterName, sourcePath, fileSize],
  );
  return res.rows[0]?.failure_count ?? 1;
}
