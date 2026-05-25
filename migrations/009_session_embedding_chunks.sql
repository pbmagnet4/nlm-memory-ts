-- Migration 009: chunk + max-pool semantic index.
--
-- Replaces session_embeddings (one vector per session, truncated at
-- MAX_EMBED_CHARS=8000) with per-chunk vectors. Recall-time score is
-- max cosine across chunks per session.
--
-- The 2026-05-25 LongMemEval-S baseline showed 98% of gold sessions
-- exceed 8000 chars and were silently truncated. Raising the per-call
-- cap (#172) hit Ollama 500s on >50% of long inputs. Chunking sidesteps
-- both: each chunk is well under the Ollama failure cliff, and the full
-- body becomes searchable. Expected lift: semantic R@5 87.2 → >92,
-- hybrid R@5 94.6 → >96.
--
-- Schema choices:
--   * Auxiliary columns (+session_id, +chunk_idx) so KNN queries return
--     session attribution without a join.
--   * Separate session_chunk_map keyed on session_id supports
--     `DELETE FROM session_embedding_chunks WHERE chunk_id IN
--     (SELECT chunk_id FROM session_chunk_map WHERE session_id = ?)`
--     since vec0 has no documented filtering on aux columns.
--
-- session_embeddings (single-vector) is intentionally left in place:
--   * keeps rollback trivial (revert recall code, old vectors still there)
--   * avoids forcing a multi-hour re-embed at deploy time; backfill
--     populates chunks asynchronously
--   * a future cleanup migration drops it once chunks are validated

CREATE VIRTUAL TABLE IF NOT EXISTS session_embedding_chunks USING vec0(
  chunk_id   INTEGER PRIMARY KEY,
  embedding  float[768],
  +session_id TEXT,
  +chunk_idx  INTEGER
);

CREATE TABLE IF NOT EXISTS session_chunk_map (
  chunk_id   INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  chunk_idx  INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_chunk_map_session
  ON session_chunk_map(session_id);

INSERT OR IGNORE INTO schema_migrations (version, name)
  VALUES (9, '009_session_embedding_chunks');
