-- Migration 013: add failure_count to adapter_state.
--
-- Tracks consecutive classify/storage failures per source file. The scheduler
-- skips files whose failure_count has reached the backoff ceiling (default 3)
-- and whose file_size has not changed since the last attempt. When the file
-- grows (new content appended), failure_count resets to 0 and the file is
-- retried. This prevents a single permanently-broken or over-large transcript
-- from flooding daemon-err.log on every 30-minute tick.

ALTER TABLE adapter_state ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (13, '013_adapter_state_failure_count');
