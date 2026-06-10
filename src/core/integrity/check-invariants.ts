/**
 * check-invariants — pure integrity check definitions.
 *
 * Each check returns a typed violation describing the problem. A clean
 * database returns an empty violations array. The SQL strings are backend-
 * agnostic where possible; per-backend runners at the bottom execute them.
 *
 * Checks:
 *   I1  no self-loop edges in session_edges for any 'kind'
 *   I2  status matches incoming edge kind: status='superseded' has an incoming
 *       'supersedes' edge; status='replaced' has an incoming 'replaces' edge
 *   I3  supersedence graph is acyclic over the union of 'supersedes' and
 *       'replaces' edges (BFS, depth-capped at 100)
 *   I4  every session_edges endpoint exists in sessions
 *   I5  at most one active fact per (subject, predicate); every superseded_by
 *       references an existing facts.id
 *   I6  every non-null adapter_state.session_id references a sessions.id
 */

import type Database from "better-sqlite3";
import type { Pool } from "pg";

export interface Violation {
  readonly id: string;
  readonly description: string;
  readonly count: number;
  readonly sampleIds: ReadonlyArray<string>;
}

// ─── SQL strings (portable) ──────────────────────────────────────────────────

const SQL_I1 = `
  SELECT from_session AS bad_id
  FROM session_edges
  WHERE from_session = to_session
  LIMIT 6
`;

const SQL_I2_ORPHANED = `
  SELECT s.id AS bad_id
  FROM sessions s
  WHERE s.status = 'superseded'
    AND NOT EXISTS (
      SELECT 1 FROM session_edges e
      WHERE e.to_session = s.id AND e.kind = 'supersedes'
    )
  LIMIT 6
`;

const SQL_I2_ORPHANED_REPLACED = `
  SELECT s.id AS bad_id
  FROM sessions s
  WHERE s.status = 'replaced'
    AND NOT EXISTS (
      SELECT 1 FROM session_edges e
      WHERE e.to_session = s.id AND e.kind = 'replaces'
    )
  LIMIT 6
`;

const SQL_I4_MISSING_FROM = `
  SELECT e.from_session AS bad_id
  FROM session_edges e
  WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.from_session)
  LIMIT 6
`;

const SQL_I4_MISSING_TO = `
  SELECT e.to_session AS bad_id
  FROM session_edges e
  WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.to_session)
  LIMIT 6
`;

const SQL_I5_DUPLICATE_FACTS = `
  SELECT id AS bad_id
  FROM facts
  WHERE superseded_by IS NULL
  GROUP BY subject, predicate
  HAVING count(*) > 1
  LIMIT 6
`;

const SQL_I5_DANGLING_SUPERSEDED_BY = `
  SELECT f.id AS bad_id
  FROM facts f
  WHERE f.superseded_by IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM facts f2 WHERE f2.id = f.superseded_by)
  LIMIT 6
`;

const SQL_I6 = `
  SELECT a.session_id AS bad_id
  FROM adapter_state a
  WHERE a.session_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = a.session_id)
  LIMIT 6
`;

// ─── Graph traversal — backend-agnostic ──────────────────────────────────────

export type EdgeLoader = () => ReadonlyArray<{ from_session: string; to_session: string }>;

const MAX_CYCLE_DEPTH = 100;

export function detectCycles(loadEdges: EdgeLoader): Violation | null {
  const edges = loadEdges();
  const children = new Map<string, string[]>();
  for (const { from_session, to_session } of edges) {
    const list = children.get(from_session);
    if (list) list.push(to_session);
    else children.set(from_session, [to_session]);
  }

  const cycleNodes: string[] = [];
  const visited = new Set<string>();

  for (const start of children.keys()) {
    if (visited.has(start)) continue;
    const queue: Array<{ node: string; depth: number }> = [{ node: start, depth: 0 }];
    const inPath = new Set<string>();

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth > MAX_CYCLE_DEPTH) break;
      if (inPath.has(item.node)) {
        if (cycleNodes.length < 5) cycleNodes.push(item.node);
        continue;
      }
      inPath.add(item.node);
      visited.add(item.node);
      for (const child of children.get(item.node) ?? []) {
        queue.push({ node: child, depth: item.depth + 1 });
      }
    }
  }

  if (cycleNodes.length === 0) return null;
  return {
    id: "I3",
    description: "supersedence graph contains cycles",
    count: cycleNodes.length,
    sampleIds: cycleNodes.slice(0, 5),
  };
}

// ─── SQLite runner ────────────────────────────────────────────────────────────

function sqliteRows(db: Database.Database, sql: string): string[] {
  return db
    .prepare<[], { bad_id: string }>(sql)
    .all()
    .map((r) => r.bad_id);
}

function sqliteCount(db: Database.Database, sql: string): number {
  const countSql = `SELECT count(*) AS n FROM (${sql.replace(/LIMIT \d+/, "")})`;
  return (db.prepare<[], { n: number }>(countSql).get()?.n) ?? 0;
}

function buildViolation(id: string, description: string, samples: string[], count: number): Violation {
  return { id, description, count, sampleIds: samples.slice(0, 5) };
}

export function runChecksOnSqlite(db: Database.Database): ReadonlyArray<Violation> {
  const violations: Violation[] = [];

  // I1
  const i1Samples = sqliteRows(db, SQL_I1);
  if (i1Samples.length > 0) {
    const count = sqliteCount(db, SQL_I1);
    violations.push(buildViolation("I1", "self-loop edges in session_edges", i1Samples, count));
  }

  // I2
  const i2Samples = sqliteRows(db, SQL_I2_ORPHANED);
  if (i2Samples.length > 0) {
    const count = sqliteCount(db, SQL_I2_ORPHANED);
    violations.push(buildViolation("I2", "sessions marked superseded with no incoming supersedes edge", i2Samples, count));
  }
  const i2ReplacedSamples = sqliteRows(db, SQL_I2_ORPHANED_REPLACED);
  if (i2ReplacedSamples.length > 0) {
    const count = sqliteCount(db, SQL_I2_ORPHANED_REPLACED);
    violations.push(buildViolation("I2r", "sessions marked replaced with no incoming replaces edge", i2ReplacedSamples, count));
  }

  // I3
  const i3 = detectCycles(() =>
    db
      .prepare<[], { from_session: string; to_session: string }>(
        "SELECT from_session, to_session FROM session_edges WHERE kind IN ('supersedes', 'replaces')",
      )
      .all(),
  );
  if (i3) violations.push(i3);

  // I4
  const i4FromSamples = sqliteRows(db, SQL_I4_MISSING_FROM);
  const i4ToSamples = sqliteRows(db, SQL_I4_MISSING_TO);
  const i4All = [...new Set([...i4FromSamples, ...i4ToSamples])];
  if (i4All.length > 0) {
    const countFrom = sqliteCount(db, SQL_I4_MISSING_FROM);
    const countTo = sqliteCount(db, SQL_I4_MISSING_TO);
    violations.push(buildViolation("I4", "session_edges reference session ids not in sessions table", i4All, countFrom + countTo));
  }

  // I5
  const i5DupSamples = sqliteRows(db, SQL_I5_DUPLICATE_FACTS);
  if (i5DupSamples.length > 0) {
    const count = sqliteCount(db, SQL_I5_DUPLICATE_FACTS);
    violations.push(buildViolation("I5a", "multiple active facts for same (subject, predicate)", i5DupSamples, count));
  }
  const i5DangleSamples = sqliteRows(db, SQL_I5_DANGLING_SUPERSEDED_BY);
  if (i5DangleSamples.length > 0) {
    const count = sqliteCount(db, SQL_I5_DANGLING_SUPERSEDED_BY);
    violations.push(buildViolation("I5b", "facts.superseded_by references non-existent facts.id", i5DangleSamples, count));
  }

  // I6
  const i6Samples = sqliteRows(db, SQL_I6);
  if (i6Samples.length > 0) {
    const count = sqliteCount(db, SQL_I6);
    violations.push(buildViolation("I6", "adapter_state.session_id references non-existent sessions.id", i6Samples, count));
  }

  return violations;
}

// ─── PostgreSQL runner ────────────────────────────────────────────────────────

async function pgRows(pool: Pool, sql: string): Promise<string[]> {
  const stripped = sql.replace(/LIMIT \d+/, "LIMIT 6");
  const result = await pool.query<{ bad_id: string }>(stripped);
  return result.rows.map((r) => r.bad_id);
}

async function pgCount(pool: Pool, sql: string): Promise<number> {
  const countSql = `SELECT count(*) AS n FROM (${sql.replace(/LIMIT \d+/, "")}) AS sub`;
  const result = await pool.query<{ n: string }>(countSql);
  return Number.parseInt(result.rows[0]?.n ?? "0", 10);
}

export async function runChecksOnPg(pool: Pool): Promise<ReadonlyArray<Violation>> {
  const violations: Violation[] = [];

  // I1
  const i1Samples = await pgRows(pool, SQL_I1);
  if (i1Samples.length > 0) {
    const count = await pgCount(pool, SQL_I1);
    violations.push(buildViolation("I1", "self-loop edges in session_edges", i1Samples, count));
  }

  // I2
  const i2Samples = await pgRows(pool, SQL_I2_ORPHANED);
  if (i2Samples.length > 0) {
    const count = await pgCount(pool, SQL_I2_ORPHANED);
    violations.push(buildViolation("I2", "sessions marked superseded with no incoming supersedes edge", i2Samples, count));
  }
  const i2ReplacedSamples = await pgRows(pool, SQL_I2_ORPHANED_REPLACED);
  if (i2ReplacedSamples.length > 0) {
    const count = await pgCount(pool, SQL_I2_ORPHANED_REPLACED);
    violations.push(buildViolation("I2r", "sessions marked replaced with no incoming replaces edge", i2ReplacedSamples, count));
  }

  // I3
  const edgeResult = await pool.query<{ from_session: string; to_session: string }>(
    "SELECT from_session, to_session FROM session_edges WHERE kind IN ('supersedes', 'replaces')",
  );
  const i3 = detectCycles(() => edgeResult.rows);
  if (i3) violations.push(i3);

  // I4
  const [i4FromSamples, i4ToSamples] = await Promise.all([
    pgRows(pool, SQL_I4_MISSING_FROM),
    pgRows(pool, SQL_I4_MISSING_TO),
  ]);
  const i4All = [...new Set([...i4FromSamples, ...i4ToSamples])];
  if (i4All.length > 0) {
    const [countFrom, countTo] = await Promise.all([
      pgCount(pool, SQL_I4_MISSING_FROM),
      pgCount(pool, SQL_I4_MISSING_TO),
    ]);
    violations.push(buildViolation("I4", "session_edges reference session ids not in sessions table", i4All, countFrom + countTo));
  }

  // I5
  const [i5DupSamples, i5DangleSamples] = await Promise.all([
    pgRows(pool, SQL_I5_DUPLICATE_FACTS),
    pgRows(pool, SQL_I5_DANGLING_SUPERSEDED_BY),
  ]);
  if (i5DupSamples.length > 0) {
    const count = await pgCount(pool, SQL_I5_DUPLICATE_FACTS);
    violations.push(buildViolation("I5a", "multiple active facts for same (subject, predicate)", i5DupSamples, count));
  }
  if (i5DangleSamples.length > 0) {
    const count = await pgCount(pool, SQL_I5_DANGLING_SUPERSEDED_BY);
    violations.push(buildViolation("I5b", "facts.superseded_by references non-existent facts.id", i5DangleSamples, count));
  }

  // I6
  const i6Samples = await pgRows(pool, SQL_I6);
  if (i6Samples.length > 0) {
    const count = await pgCount(pool, SQL_I6);
    violations.push(buildViolation("I6", "adapter_state.session_id references non-existent sessions.id", i6Samples, count));
  }

  return violations;
}

// ─── Cheap subset (I1 + I2 + I6) for scheduled watchdog ─────────────────────

export function runCheapChecksOnSqlite(db: Database.Database): ReadonlyArray<Violation> {
  const violations: Violation[] = [];

  const i1Samples = sqliteRows(db, SQL_I1);
  if (i1Samples.length > 0) {
    violations.push(buildViolation("I1", "self-loop edges in session_edges", i1Samples, sqliteCount(db, SQL_I1)));
  }

  const i2Samples = sqliteRows(db, SQL_I2_ORPHANED);
  if (i2Samples.length > 0) {
    violations.push(buildViolation("I2", "sessions marked superseded with no incoming supersedes edge", i2Samples, sqliteCount(db, SQL_I2_ORPHANED)));
  }
  const i2ReplacedSamples = sqliteRows(db, SQL_I2_ORPHANED_REPLACED);
  if (i2ReplacedSamples.length > 0) {
    violations.push(buildViolation("I2r", "sessions marked replaced with no incoming replaces edge", i2ReplacedSamples, sqliteCount(db, SQL_I2_ORPHANED_REPLACED)));
  }

  const i6Samples = sqliteRows(db, SQL_I6);
  if (i6Samples.length > 0) {
    violations.push(buildViolation("I6", "adapter_state.session_id references non-existent sessions.id", i6Samples, sqliteCount(db, SQL_I6)));
  }

  return violations;
}

export async function runCheapChecksOnPg(pool: Pool): Promise<ReadonlyArray<Violation>> {
  const violations: Violation[] = [];

  const [i1, i2, i2r, i6] = await Promise.all([
    pgRows(pool, SQL_I1),
    pgRows(pool, SQL_I2_ORPHANED),
    pgRows(pool, SQL_I2_ORPHANED_REPLACED),
    pgRows(pool, SQL_I6),
  ]);

  if (i1.length > 0) {
    violations.push(buildViolation("I1", "self-loop edges in session_edges", i1, await pgCount(pool, SQL_I1)));
  }
  if (i2.length > 0) {
    violations.push(buildViolation("I2", "sessions marked superseded with no incoming supersedes edge", i2, await pgCount(pool, SQL_I2_ORPHANED)));
  }
  if (i2r.length > 0) {
    violations.push(buildViolation("I2r", "sessions marked replaced with no incoming replaces edge", i2r, await pgCount(pool, SQL_I2_ORPHANED_REPLACED)));
  }
  if (i6.length > 0) {
    violations.push(buildViolation("I6", "adapter_state.session_id references non-existent sessions.id", i6, await pgCount(pool, SQL_I6)));
  }

  return violations;
}

// ─── --fix: mechanically safe repairs ────────────────────────────────────────

export interface FixReport {
  readonly deletedSelfLoops: number;
  readonly restoredToClosed: number;
}

export function applyFixOnSqlite(db: Database.Database): FixReport {
  const deleteResult = db
    .prepare("DELETE FROM session_edges WHERE from_session = to_session")
    .run();

  const updateSuperseded = db
    .prepare(`
      UPDATE sessions
      SET status = 'closed', updated_at = datetime('now')
      WHERE status = 'superseded'
        AND id NOT IN (SELECT to_session FROM session_edges WHERE kind = 'supersedes')
    `)
    .run();

  const updateReplaced = db
    .prepare(`
      UPDATE sessions
      SET status = 'closed', updated_at = datetime('now')
      WHERE status = 'replaced'
        AND id NOT IN (SELECT to_session FROM session_edges WHERE kind = 'replaces')
    `)
    .run();

  return {
    deletedSelfLoops: deleteResult.changes,
    restoredToClosed: updateSuperseded.changes + updateReplaced.changes,
  };
}

export async function applyFixOnPg(pool: Pool): Promise<FixReport> {
  const deleteResult = await pool.query(
    "DELETE FROM session_edges WHERE from_session = to_session",
  );

  const updateSuperseded = await pool.query(`
    UPDATE sessions
    SET status = 'closed', updated_at = NOW()
    WHERE status = 'superseded'
      AND id NOT IN (SELECT to_session FROM session_edges WHERE kind = 'supersedes')
  `);

  const updateReplaced = await pool.query(`
    UPDATE sessions
    SET status = 'closed', updated_at = NOW()
    WHERE status = 'replaced'
      AND id NOT IN (SELECT to_session FROM session_edges WHERE kind = 'replaces')
  `);

  return {
    deletedSelfLoops: deleteResult.rowCount ?? 0,
    restoredToClosed: (updateSuperseded.rowCount ?? 0) + (updateReplaced.rowCount ?? 0),
  };
}
