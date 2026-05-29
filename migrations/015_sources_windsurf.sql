-- Migration 015: add 'windsurf' to the sources.kind CHECK constraint.
--
-- SQLite does not support ALTER COLUMN to modify CHECK constraints in place.
-- Standard approach: rename → recreate → copy → drop old.

PRAGMA foreign_keys = OFF;

CREATE TABLE sources_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL CHECK (kind IN ('claude-code', 'hermes', 'hermes-agent', 'aider', 'cursor', 'windsurf', 'opencode', 'pi', 'jsonl-generic', 'webhook')),
  name          TEXT    NOT NULL UNIQUE,
  path_or_url   TEXT,
  runtime_label TEXT    NOT NULL,
  parse_config  TEXT    NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 1,
  token         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sources_new SELECT id, kind, name, path_or_url, runtime_label, parse_config, enabled, token, created_at, updated_at FROM sources;

DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;

CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled) WHERE enabled = 1;

PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (15, '015_sources_windsurf');
