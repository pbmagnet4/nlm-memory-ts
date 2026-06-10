-- nlm:no-wrap
-- Migration 019: split the mechanical `replaces` relation out of `supersedes`.
--
-- Two relations were overloaded onto one edge kind ('supersedes') and one
-- status ('superseded'): mechanical re-ingest of a grown transcript
-- (supersede-on-resume) and operator-asserted epistemic overturn. This
-- migration introduces edge kind 'replaces' + status 'replaced' for the
-- mechanical case and reclassifies existing rows.
--
-- The mechanical signature is exact, no heuristics: an edge whose two sessions
-- share the same transcript_path is a re-parse (replaces); different paths is
-- operator supersedence (untouched). See
-- docs/plans/2026-06-10-supersedence-split.md.
--
-- Widening the CHECK constraints on sessions.status and session_edges.kind
-- requires a table rebuild (SQLite cannot ALTER a CHECK constraint, and
-- better-sqlite3 forbids writable_schema edits). The rebuild runs under
-- foreign_keys=OFF so dropping the old `sessions` table does not cascade-delete
-- its dependents; the pragma is a no-op inside a transaction, hence nlm:no-wrap.

PRAGMA foreign_keys = OFF;

BEGIN;

-- ── Rebuild sessions with the widened status CHECK ──────────────────────────
DROP TRIGGER IF EXISTS sessions_ai;
DROP TRIGGER IF EXISTS sessions_au;
DROP TRIGGER IF EXISTS sessions_ad;

CREATE TABLE sessions_new (
  id                  TEXT PRIMARY KEY,
  runtime             TEXT NOT NULL,
  runtime_session_id  TEXT,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  duration_min        INTEGER,
  label               TEXT NOT NULL,
  summary             TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL CHECK(status IN ('active','closed','superseded','replaced')),
  transcript_kind     TEXT,
  transcript_path     TEXT,
  transcript_offset   INTEGER,
  transcript_length   INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sessions_new
  (id, runtime, runtime_session_id, started_at, ended_at, duration_min,
   label, summary, body, status, transcript_kind, transcript_path,
   transcript_offset, transcript_length, created_at, updated_at)
SELECT
  id, runtime, runtime_session_id, started_at, ended_at, duration_min,
  label, summary, body, status, transcript_kind, transcript_path,
  transcript_offset, transcript_length, created_at, updated_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_runtime ON sessions(runtime);

CREATE TRIGGER sessions_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO sessions_fts(rowid, label, summary, body)
  VALUES (new.rowid, new.label, new.summary, new.body);
END;
CREATE TRIGGER sessions_au AFTER UPDATE ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, label, summary, body)
  VALUES('delete', old.rowid, old.label, old.summary, old.body);
  INSERT INTO sessions_fts(rowid, label, summary, body)
  VALUES (new.rowid, new.label, new.summary, new.body);
END;
CREATE TRIGGER sessions_ad AFTER DELETE ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, label, summary, body)
  VALUES('delete', old.rowid, old.label, old.summary, old.body);
END;

-- The rebuild reassigned rowids; rebuild the external-content FTS index so its
-- rowid → session mapping matches the new sessions table.
INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild');

-- ── Rebuild session_edges with the widened kind CHECK ───────────────────────
CREATE TABLE session_edges_new (
  from_session        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  to_session          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK(kind IN ('supersedes','replaces','continues','branched_from','merged_from')),
  PRIMARY KEY (from_session, to_session, kind)
);

INSERT INTO session_edges_new (from_session, to_session, kind)
SELECT from_session, to_session, kind FROM session_edges;

DROP TABLE session_edges;
ALTER TABLE session_edges_new RENAME TO session_edges;

CREATE INDEX IF NOT EXISTS idx_session_edges_from ON session_edges(from_session);
CREATE INDEX IF NOT EXISTS idx_session_edges_to ON session_edges(to_session);
CREATE INDEX IF NOT EXISTS idx_session_edges_kind ON session_edges(kind);

-- ── Reclassify mechanical edges + predecessor rows ──────────────────────────
UPDATE session_edges SET kind = 'replaces'
WHERE kind = 'supersedes'
  AND (SELECT transcript_path FROM sessions WHERE id = from_session)
    = (SELECT transcript_path FROM sessions WHERE id = to_session);

UPDATE sessions SET status = 'replaced', updated_at = datetime('now')
WHERE status = 'superseded'
  AND id IN (SELECT to_session FROM session_edges WHERE kind = 'replaces');

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (19, '019_split_replaces');

COMMIT;

PRAGMA foreign_keys = ON;
