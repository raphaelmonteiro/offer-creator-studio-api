import * as fs from 'fs/promises';
import * as path from 'path';
import type { DataSource } from 'typeorm';
import { GalleryPhotoSeed, insertGalleryPhoto } from '../../../shared/testing/e2e-seed';

/**
 * Fotos da Galeria do e2e do provedor real (só testes): cada foto é gravada pelo spec no banco de e2e, com o arquivo na
 * pasta de uploads do e2e e a URL pelo `CDN_URL` do harness, e apagada no fim. A medida que o job grava vem do arquivo.
 */

export interface SeededPhoto {
  id: string;
  filename: string;
  width: number;
  height: number;
}

export async function seedGalleryPhoto(
  target: { dataSource: DataSource; uploadsDir: string; cdnUrl: string },
  seed: GalleryPhotoSeed,
): Promise<SeededPhoto> {
  const { dataSource, ...files } = target;
  const { id } = await insertGalleryPhoto(dataSource, files, seed);
  return { id, filename: seed.filename, width: seed.width, height: seed.height };
}

/** Apaga as fotos gravadas pelo spec (linhas e arquivos). */
export async function removeGalleryPhotos(
  target: { dataSource: DataSource; uploadsDir: string },
  photos: SeededPhoto[],
): Promise<void> {
  await target.dataSource.query(`DELETE FROM gallery_images WHERE id = ANY($1::uuid[])`, [
    photos.map((photo) => photo.id),
  ]);
  for (const photo of photos) {
    await fs.rm(path.join(target.uploadsDir, 'gallery', photo.filename), { force: true });
  }
}
