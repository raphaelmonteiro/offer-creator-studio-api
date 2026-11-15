import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { GalleryProductLinkService } from '../../modules/gallery/gallery-product-link.service';
import { GalleryService } from '../../modules/gallery/gallery.service';

/** O SQL que o app roda no boot (`GalleryEmbeddingService`), lido do próprio app para não haver cópia. */
const BOOTSTRAP_SQL_PATH = path.join(
  __dirname,
  '..',
  '..',
  'modules',
  'gallery',
  'sql',
  '001_pgvector_setup.sql',
);

/** Os comandos do `001_pgvector_setup.sql`, separados como o `GalleryEmbeddingService.onModuleInit` separa. */
export function pgvectorSetupStatements(): string[] {
  return fs
    .readFileSync(BOOTSTRAP_SQL_PATH, 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * A Galeria do banco de e2e pelo mesmo SQL do boot do app, sem depender das flags de IA (D-2): as duas tabelas do
 * `GalleryService`, o `001_pgvector_setup.sql` (colunas de dados e de embedding, índices e `client_preferred_images`)
 * e o índice dos nomes. Ordem fixa: o `001` referencia `clients` e `gallery_images`, então roda depois do
 * `synchronize` e das tabelas do `GalleryService`; o índice dos nomes lê `metadata`, que o `001` cria.
 *
 * Os dois `onModuleInit` do app só registram a falha em log, então a existência do que criam é conferida aqui.
 */
export async function createGallerySchema(dataSource: DataSource): Promise<void> {
  const none = null as never;
  await new GalleryService(none, none, dataSource, none, none, none).onModuleInit();
  for (const statement of pgvectorSetupStatements()) await dataSource.query(statement);
  await new GalleryProductLinkService(dataSource, none).onModuleInit();
  await assertGallerySchema(dataSource);
}

async function assertGallerySchema(dataSource: DataSource): Promise<void> {
  const [found] = await dataSource.query(
    `SELECT to_regclass('gallery_folders') AS folders, to_regclass('gallery_images') AS images,
            to_regclass('idx_gallery_images_aliases') AS aliases`,
  );
  const missing = Object.entries({
    gallery_folders: found.folders,
    gallery_images: found.images,
    idx_gallery_images_aliases: found.aliases,
  })
    .filter(([, regclass]) => !regclass)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`A montagem da Galeria no banco de e2e não criou: ${missing.join(', ')}.`);
  }
}
