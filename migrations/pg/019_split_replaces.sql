-- PG parity for SQLite migration 019: split the mechanical `replaces` relation
-- out of `supersedes`.
--
-- One-shot repair, applied manually by an operator against a PG canonical store
-- (PgStorage.init only runs 001_initial.sql; there is no version-gated runner on
-- the PG side). Mirrors migrations/019_split_replaces.sql.
--
-- Widens the CHECK constraints on sessions.status and session_edges.kind to
-- admit 'replaced' / 'replaces', then reclassifies existing mechanical edges:
-- an edge whose two sessions share the same transcript_path is a re-parse
-- (replaces); different paths is operator supersedence (untouched).

BEGIN;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_status_check
  CHECK (status IN ('active', 'closed', 'superseded', 'replaced'));

ALTER TABLE session_edges DROP CONSTRAINT IF EXISTS session_edges_kind_check;
ALTER TABLE session_edges ADD CONSTRAINT session_edges_kind_check
  CHECK (kind IN ('supersedes', 'replaces', 'continues'));

UPDATE session_edges e SET kind = 'replaces'
WHERE e.kind = 'supersedes'
  AND (SELECT transcript_path FROM sessions WHERE id = e.from_session)
    = (SELECT transcript_path FROM sessions WHERE id = e.to_session);

UPDATE sessions SET status = 'replaced', updated_at = NOW()
WHERE status = 'superseded'
  AND id IN (SELECT to_session FROM session_edges WHERE kind = 'replaces');

COMMIT;
