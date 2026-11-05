import * as sharp from 'sharp';

/** Lado maior da prévia WebP. */
export const PREVIEW_MAX_EDGE = 1024;

export interface SceneImageFile {
  filename: string;
  buffer: Buffer;
  width: number;
  height: number;
}

export interface SceneOutputs {
  master: SceneImageFile;
  preview: SceneImageFile;
}

/**
 * Master PNG (a imagem do provedor, sem reprocessar) e prévia WebP de 1024 px no lado maior. A
 * leitura das dimensões também valida que o provedor devolveu uma imagem de verdade.
 */
export async function buildSceneOutputs(png: Buffer): Promise<SceneOutputs> {
  const metadata = await sharp(png).metadata();
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    throw new Error('O provedor não devolveu uma imagem PNG válida');
  }
  const preview = await sharp(png)
    .resize({
      width: PREVIEW_MAX_EDGE,
      height: PREVIEW_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return {
    master: { filename: 'master.png', buffer: png, width: metadata.width, height: metadata.height },
    preview: {
      filename: 'preview.webp',
      buffer: preview.data,
      width: preview.info.width,
      height: preview.info.height,
    },
  };
}
