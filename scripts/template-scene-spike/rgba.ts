import * as sharp from 'sharp';
import type { Img } from './image';
import { emptyRaster } from './morph';
import type { Raster } from './morph';

/** Imagem RGBA de 8 bits (recorte com alfa). */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export async function loadRgba(png: Buffer): Promise<Rgba> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/** Fração de pixels com alfa >= 128. */
export function alphaCoverage(img: Rgba): number {
  let count = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] >= 128) count += 1;
  return count / (img.width * img.height);
}

/** Cola `patch` (com alfa) em `base` na posição (x, y). Devolve a cena nova e os rasters de objeto e interior. */
export function pasteRgba(
  base: Img,
  patch: Rgba,
  x: number,
  y: number,
): { image: Img; object: Raster; interior: Raster } {
  const data = base.data.slice();
  const object = emptyRaster(base.width, base.height);
  const interior = emptyRaster(base.width, base.height);
  for (let j = 0; j < patch.height; j += 1) {
    for (let i = 0; i < patch.width; i += 1) {
      const a = patch.data[(j * patch.width + i) * 4 + 3];
      if (a === 0) continue;
      const k = (y + j) * base.width + x + i;
      for (let c = 0; c < 3; c += 1) {
        const src = patch.data[(j * patch.width + i) * 4 + c];
        data[k * 3 + c] = Math.round((data[k * 3 + c] * (255 - a) + src * a) / 255);
      }
      object.data[k] = 255;
      if (a === 255) interior.data[k] = 255;
    }
  }
  return { image: { width: base.width, height: base.height, data }, object, interior };
}
