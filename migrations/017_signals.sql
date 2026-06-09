-- Migration 017: signals - agent self-improvement telemetry lane.
--
-- Distinct from facts: append-only, idempotent on a deterministic id, no
-- supersedence pointer, no embeddings. No FK to sessions; a signal can arrive
-- before or without a session row, session_id is a soft link.

CREATE TABLE IF NOT EXISTS signals (
  id            TEXT PRIMARY KEY,
  v             INTEGER NOT NULL DEFAULT 1,
  install_scope TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('gate', 'eval', 'review', 'test')),
  producer      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'fix', 'exhausted')),
  model         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  step          TEXT,
  detail        TEXT,
  session_id    TEXT,
  ts            TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Aggregation hot path: failure-mode roll-up scoped to an install + repo/model.
CREATE INDEX IF NOT EXISTS idx_signals_agg
  ON signals(install_scope, repo, model, kind, step);

-- Retention prune + recency window scans.
CREATE INDEX IF NOT EXISTS idx_signals_ts
  ON signals(ts);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (17, '017_signals');
