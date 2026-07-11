-- Idempotent setup for gallery image embeddings (pgvector) + structured metadata.
-- Executed on application boot by GalleryEmbeddingService.onModuleInit.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE gallery_images
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

ALTER TABLE gallery_images
  ADD COLUMN IF NOT EXISTS metadata jsonb;

ALTER TABLE gallery_images
  ADD COLUMN IF NOT EXISTS metadata_status varchar(16);

ALTER TABLE gallery_images
  ADD COLUMN IF NOT EXISTS metadata_error text;

ALTER TABLE gallery_images
  ADD COLUMN IF NOT EXISTS metadata_embedding vector(1536);

-- HNSW index for cosine distance. m=16, ef_construction=64 are pgvector defaults
-- and perform well up to a few million rows. Index build is async-friendly: rows
-- without embedding are simply skipped by the partial predicate.
CREATE INDEX IF NOT EXISTS gallery_images_embedding_hnsw_idx
  ON gallery_images
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS gallery_images_metadata_embedding_hnsw_idx
  ON gallery_images
  USING hnsw (metadata_embedding vector_cosine_ops)
  WHERE metadata_embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS gallery_images_metadata_status_idx
  ON gallery_images (metadata_status)
  WHERE metadata_status IS NULL OR metadata_status = 'pending';
