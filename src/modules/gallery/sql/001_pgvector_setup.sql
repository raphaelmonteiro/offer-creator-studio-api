-- Idempotent setup for gallery image embeddings (pgvector).
-- Executed on application boot by GalleryEmbeddingService.onModuleInit.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE gallery_images
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW index for cosine distance. m=16, ef_construction=64 are pgvector defaults
-- and perform well up to a few million rows. Index build is async-friendly: rows
-- without embedding are simply skipped by the partial predicate.
CREATE INDEX IF NOT EXISTS gallery_images_embedding_hnsw_idx
  ON gallery_images
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
