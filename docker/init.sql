-- PAI pgvector schema
-- Run automatically when the container is first created.
-- Idempotent: all CREATE statements use IF NOT EXISTS.

-- Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- pai_files — file-level metadata for change detection
-- Mirrors: federation.db memory_files table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pai_files (
  project_id   INTEGER     NOT NULL,
  path         TEXT        NOT NULL,
  source       TEXT        NOT NULL DEFAULT 'memory',
  tier         TEXT        NOT NULL DEFAULT 'topic',
  hash         TEXT        NOT NULL,
  mtime        BIGINT      NOT NULL,
  size         INTEGER     NOT NULL,
  PRIMARY KEY (project_id, path)
);

CREATE INDEX IF NOT EXISTS idx_pf_project ON pai_files (project_id);

-- ---------------------------------------------------------------------------
-- pai_chunks — chunked text with optional vector embedding
-- Mirrors: federation.db memory_chunks table
-- embedding: 768-dimensional float32 vector (Snowflake Arctic Embed m v1.5 output)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pai_chunks (
  id           TEXT        PRIMARY KEY,
  project_id   INTEGER     NOT NULL,
  source       TEXT        NOT NULL DEFAULT 'memory',
  tier         TEXT        NOT NULL DEFAULT 'topic',
  path         TEXT        NOT NULL,
  start_line   INTEGER     NOT NULL,
  end_line     INTEGER     NOT NULL,
  hash         TEXT        NOT NULL,
  text         TEXT        NOT NULL,
  updated_at   BIGINT      NOT NULL,
  -- pgvector embedding (768 dims = Snowflake/snowflake-arctic-embed-m-v1.5); NULL until embedChunks() runs
  embedding    vector(768),
  -- Pre-computed tsvector for fast GIN-indexed full-text search
  fts_vector   tsvector
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_pc_project       ON pai_chunks (project_id);
CREATE INDEX IF NOT EXISTS idx_pc_source        ON pai_chunks (project_id, source);
CREATE INDEX IF NOT EXISTS idx_pc_tier          ON pai_chunks (tier);
CREATE INDEX IF NOT EXISTS idx_pc_path          ON pai_chunks (project_id, path);

-- GIN index for full-text search (tsvector)
CREATE INDEX IF NOT EXISTS idx_pc_fts           ON pai_chunks USING GIN (fts_vector);

-- HNSW index for approximate nearest-neighbor vector search
-- vector_cosine_ops = cosine distance (<=>)
-- ef_construction=64, m=16 are sensible defaults for ~10k-100k chunks
CREATE INDEX IF NOT EXISTS idx_pc_embedding_hnsw
  ON pai_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Partial index: only rows with embeddings are relevant for vector search
CREATE INDEX IF NOT EXISTS idx_pc_has_embedding ON pai_chunks (id)
  WHERE embedding IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Trigger: keep fts_vector current on insert/update
-- This avoids needing to call to_tsvector() in every INSERT — the trigger
-- handles it automatically. The application still passes the text to
-- to_tsvector() in INSERT statements for clarity, but this trigger is a
-- safety net for direct updates.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pai_chunks_fts_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.fts_vector := to_tsvector('english', COALESCE(NEW.text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pai_chunks_fts ON pai_chunks;
CREATE TRIGGER trg_pai_chunks_fts
  BEFORE INSERT OR UPDATE OF text
  ON pai_chunks
  FOR EACH ROW
  EXECUTE FUNCTION pai_chunks_fts_update();

-- ---------------------------------------------------------------------------
-- Summary view (handy for debugging)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW pai_stats AS
SELECT
  (SELECT COUNT(*) FROM pai_files)  AS total_files,
  (SELECT COUNT(*) FROM pai_chunks) AS total_chunks,
  (SELECT COUNT(*) FROM pai_chunks WHERE embedding IS NOT NULL) AS embedded_chunks,
  (SELECT COUNT(DISTINCT project_id) FROM pai_chunks) AS projects_indexed;
