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

-- Feature 12 — Imagens preferidas por cliente (vínculo real N:N).
-- Uma foto pode ser preferida por vários clientes; um cliente tem várias
-- preferidas. Não duplica arquivos: aponta para gallery_images existentes.
CREATE TABLE IF NOT EXISTS client_preferred_images (
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  image_id   uuid NOT NULL REFERENCES gallery_images(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, image_id)
);

CREATE INDEX IF NOT EXISTS client_preferred_images_client_idx
  ON client_preferred_images (client_id);

CREATE INDEX IF NOT EXISTS client_preferred_images_image_idx
  ON client_preferred_images (image_id);
