import * as sharp from 'sharp';
import { cropImg, pasteImg } from './image';
import type { Img } from './image';
import { seamSsim } from './metrics';
import { cropRaster, emptyRaster, erode } from './morph';
import type { Box, Raster } from './morph';

export class RecomposeMismatchError extends Error {
  readonly code = 'recompose_mismatch';
  constructor(readonly mismatched: number) {
    super(
      `recompose_mismatch: ${mismatched} pixel(s) fora da região autorizada diferem da cena original`,
    );
  }
}

export const DEFAULT_FEATHER = 24;

/** α = blur(erode(A, f/2), σ = f/4), cortado a 0 fora de A. Recorte `box` da cena, 8 bits. */
export async function featherAlpha(
  authorizedScene: Raster,
  box: Box,
  feather: number,
): Promise<Uint8Array> {
  // Erosão só na janela do recorte, com a borda da imagem contando como preenchida (equivale à cena inteira).
  const r = Math.round(feather / 2);
  const padded = emptyRaster(box.w + 2 * r, box.h + 2 * r);
  for (let y = 0; y < padded.height; y += 1) {
    const sy = box.y - r + y;
    for (let x = 0; x < padded.width; x += 1) {
      const sx = box.x - r + x;
      const outside =
        sx < 0 || sy < 0 || sx >= authorizedScene.width || sy >= authorizedScene.height;
      padded.data[y * padded.width + x] = outside
        ? 255
        : authorizedScene.data[sy * authorizedScene.width + sx];
    }
  }
  const eroded = cropRaster(erode(padded, r), { x: r, y: r, w: box.w, h: box.h });
  const sigma = Math.max(0.3, feather / 4);
  const blurred = await sharp(Buffer.from(eroded.data), {
    raw: { width: box.w, height: box.h, channels: 1 },
  })
    .blur(sigma)
    .extractChannel(0)
    .raw()
    .toBuffer();
  const inA = cropRaster(authorizedScene, box).data;
  const alpha = new Uint8Array(blurred.length);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = inA[i] ? blurred[i] : 0;
  return alpha;
}

export interface Recomposed {
  /** Cena inteira com o recorte recomposto. */
  final: Img;
  alpha: Uint8Array;
  seamSsim: number | null;
}

/** final = original·(1−α) + bruta·α dentro do recorte; fora do recorte a cena é a original. */
export async function recompose(
  original: Img,
  raw: Img,
  box: Box,
  authorizedScene: Raster,
  feather: number = DEFAULT_FEATHER,
): Promise<Recomposed> {
  if (raw.width !== box.w || raw.height !== box.h)
    throw new Error('A saída bruta deve ter o tamanho do recorte');
  const base = cropImg(original, box.x, box.y, box.w, box.h);
  const alpha = await featherAlpha(authorizedScene, box, feather);
  const blended = new Uint8Array(base.data.length);
  for (let i = 0; i < alpha.length; i += 1) {
    const a = alpha[i];
    for (let c = 0; c < 3; c += 1) {
      blended[i * 3 + c] = Math.round(
        (base.data[i * 3 + c] * (255 - a) + raw.data[i * 3 + c] * a) / 255,
      );
    }
  }
  const patch: Img = { width: box.w, height: box.h, data: blended };
  return {
    final: pasteImg(original, patch, box.x, box.y),
    alpha,
    seamSsim: seamSsim(patch, raw, alpha),
  };
}

/** Conferência byte a byte: fora de A, o final tem de ser idêntico ao original. */
export function verifyOutside(original: Img, final: Img, authorizedScene: Raster): void {
  let mismatched = 0;
  for (let i = 0; i < authorizedScene.data.length; i += 1) {
    if (authorizedScene.data[i]) continue;
    const k = i * 3;
    if (
      original.data[k] !== final.data[k] ||
      original.data[k + 1] !== final.data[k + 1] ||
      original.data[k + 2] !== final.data[k + 2]
    ) {
      mismatched += 1;
    }
  }
  if (mismatched > 0) throw new RecomposeMismatchError(mismatched);
}

export async function featherSweep(
  original: Img,
  raw: Img,
  box: Box,
  authorizedScene: Raster,
  feathers: number[],
): Promise<Array<{ feather: number; seamSsim: number | null }>> {
  const out: Array<{ feather: number; seamSsim: number | null }> = [];
  for (const feather of feathers) {
    const r = await recompose(original, raw, box, authorizedScene, feather);
    out.push({ feather, seamSsim: r.seamSsim });
  }
  return out;
}
