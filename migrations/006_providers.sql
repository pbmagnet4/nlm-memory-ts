-- Migration 006: providers registry.
--
-- Each row represents one LLM endpoint configured for classification or
-- (future) embedding. The classifier reads this table to choose a
-- provider/model at boot; the UI mutates it through /api/providers.
--
-- API key storage. v0 stores keys in the api_key column. This is fine
-- because the SQLite file already contains the user's transcripts —
-- anyone with disk access already has everything sensitive. Phase 2
-- (Tauri shell) migrates keys to the OS keychain and replaces the column
-- with a keychain reference. The API shape stays the same.
--
-- `kind` is the structural family (openai-compatible, ollama,
-- anthropic-native, deepseek). The classifier+model UI uses it to decide
-- which client class to instantiate.
--
-- See docs/plans/desktop-product.md (Phase 0 task 3).

CREATE TABLE IF NOT EXISTS providers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL CHECK (kind IN ('deepseek', 'ollama', 'openai', 'anthropic', 'openrouter', 'openai-compatible')),
  name          TEXT    NOT NULL UNIQUE,
  base_url      TEXT,
  api_key       TEXT,
  default_model TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_providers_enabled ON providers(enabled) WHERE enabled = 1;

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (6, '006_providers');
