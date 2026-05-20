-- One-time safety rebuild of the sessions_fts external-content FTS5 index.
-- The virtual table and its sync triggers (sessions_ai / sessions_au /
-- sessions_ad) were declared in migration 000 and have fired on every write
-- since, so the index is normally already in sync. This rebuild guarantees
-- the index matches every existing sessions row before the recall path
-- starts depending on FTS5 for keyword search. Safe and idempotent.
INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild');

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (8, 'fts_rebuild');
