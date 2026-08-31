-- Feature 14 — Fase 2. Espelho local do dump da Open Food Facts.
-- Idempotente; aplicado pelo script de ingestão antes da carga.
--
-- A OFF é gratuita, offline e sem cota — resolve o subconjunto alimentar da
-- galeria antes de gastar consulta paga no Cosmos. `pg_trgm` já é criada em
-- modules/gallery/sql/001_pgvector_setup.sql.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE IF NOT EXISTS off_products (
  gtin           varchar(14) PRIMARY KEY,
  product_name   text,
  brand_raw      text,
  brand_norm     text NOT NULL DEFAULT '',
  quantity_raw   text,
  quantity_value numeric,
  quantity_unit  varchar(4),
  categories     text,
  -- Colunas adicionais (medidas no dump: preenchimento no pool de candidatos BR).
  image_url      text,      -- col 83  — 89,7%  ← habilita verificação visual
  serving_size   text,      -- col 51  — 84,1%
  kcal_100g      numeric,   -- col 90  — 84,2%  ← discrimina variante/sabor
  carbs_100g     numeric,   -- col 130 — 83,4%
  protein_100g   numeric,   -- col 151 — 83,2%
  fat_100g       numeric,   -- col 93  — 83,1%
  ingested_at    timestamptz NOT NULL DEFAULT now()
);

-- Colunas adicionadas depois da primeira versão da tabela.
ALTER TABLE off_products ADD COLUMN IF NOT EXISTS image_url    text;
ALTER TABLE off_products ADD COLUMN IF NOT EXISTS serving_size text;
ALTER TABLE off_products ADD COLUMN IF NOT EXISTS kcal_100g    numeric;
ALTER TABLE off_products ADD COLUMN IF NOT EXISTS carbs_100g   numeric;
ALTER TABLE off_products ADD COLUMN IF NOT EXISTS protein_100g numeric;
ALTER TABLE off_products ADD COLUMN IF NOT EXISTS fat_100g     numeric;

-- Lookup principal do matcher: marca normalizada + quantidade canônica.
CREATE INDEX IF NOT EXISTS off_products_lookup_idx
  ON off_products (brand_norm, quantity_unit, quantity_value)
  WHERE brand_norm <> '';

CREATE INDEX IF NOT EXISTS off_products_brand_norm_idx
  ON off_products (brand_norm)
  WHERE brand_norm <> '';

-- Fallback por similaridade de nome quando a marca não bate exatamente.
CREATE INDEX IF NOT EXISTS off_products_name_trgm_idx
  ON off_products USING gin (product_name gin_trgm_ops);
