import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import type { DataSource } from 'typeorm';

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

interface PhotoSeed {
  filename: string;
  width: number;
  height: number;
  /** O que a foto guarda em `metadata`: o EAN, ou o nome já escolhido (`aliases`). */
  metadata: object;
}

export async function seedGalleryPhoto(
  target: { dataSource: DataSource; uploadsDir: string; cdnUrl: string },
  seed: PhotoSeed,
): Promise<SeededPhoto> {
  const { dataSource, uploadsDir, cdnUrl } = target;
  const dir = path.join(uploadsDir, 'gallery');
  await fs.mkdir(dir, { recursive: true });
  const png = await sharp({
    create: { width: seed.width, height: seed.height, channels: 3, background: '#2a8a3a' },
  })
    .png()
    .toBuffer();
  await fs.writeFile(path.join(dir, seed.filename), png);
  const url = `${cdnUrl.replace(/\/+$/, '')}/gallery/${seed.filename}`;
  const [row] = await dataSource.query(
    `INSERT INTO gallery_images (filename, url, "thumbnailUrl", "mimeType", size, metadata, metadata_status)
     VALUES ($1, $2, $2, 'image/png', $3, $4::jsonb, 'ready') RETURNING id`,
    [seed.filename, url, png.length, JSON.stringify(seed.metadata)],
  );
  return { id: row.id, filename: seed.filename, width: seed.width, height: seed.height };
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
