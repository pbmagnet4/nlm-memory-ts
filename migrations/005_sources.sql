-- Migration 005: sources registry.
--
-- Each row represents one transcript source the daemon should scan. The
-- three hardcoded adapters (claude-code / hermes / pi) become seeded rows
-- pointing at the same parse logic; future custom JSONL or webhook sources
-- live alongside them.
--
-- Parse config is a JSON blob whose shape depends on `kind`:
--   - "claude-code" / "hermes" / "pi": preset adapters. parse_config is
--     reserved but unused — paths come from path_or_url.
--   - "jsonl-generic": { sessionIdField, textField, startedAtField,
--     roleField, runtimeLabel, ... }
--   - "webhook": parse_config is empty; ingest is push-based.
--
-- See docs/plans/desktop-product.md (Phase 0).

CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL CHECK (kind IN ('claude-code', 'hermes', 'pi', 'jsonl-generic', 'webhook')),
  name          TEXT    NOT NULL UNIQUE,
  path_or_url   TEXT,
  runtime_label TEXT    NOT NULL,
  parse_config  TEXT    NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled) WHERE enabled = 1;

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (5, '005_sources');
