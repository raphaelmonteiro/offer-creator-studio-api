import * as sharp from 'sharp';
import { erode } from '../../../shared/image/morphology';
import { Box, cropRaster, emptyRaster, Raster } from '../../../shared/image/raster';
import { cropImg, Img, pasteImg } from '../../../shared/image/rgb';
import { seamSsim } from './scene-metrics';

/** A conferência byte a byte falhou: algo fora da região de recomposição mudou. */
export class RecomposeMismatchError extends Error {
  readonly code = 'RECOMPOSE_MISMATCH';
  constructor(readonly mismatched: number) {
    super(`${mismatched} pixel(s) fora da região de recomposição diferem da cena original`);
  }
}

/** Recorte `box` da região, com 1 fora da imagem (a borda da imagem conta como região). */
function paddedRegion(region: Raster, box: Box, r: number): Raster {
  const padded = emptyRaster(box.w + 2 * r, box.h + 2 * r);
  for (let y = 0; y < padded.height; y += 1) {
    const sy = box.y - r + y;
    for (let x = 0; x < padded.width; x += 1) {
      const sx = box.x - r + x;
      const outside = sx < 0 || sy < 0 || sx >= region.width || sy >= region.height;
      padded.data[y * padded.width + x] = outside ? 255 : region.data[sy * region.width + sx];
    }
  }
  return padded;
}

/**
 * α = blur(erode(R, f/2), σ = f/4), cortado a 0 fora de R. Calculado só na janela do recorte, com a
 * borda da imagem contando como preenchida (equivale a eroder a cena inteira).
 */
export async function featherAlpha(region: Raster, box: Box, feather: number): Promise<Uint8Array> {
  const r = Math.round(feather / 2);
  const eroded = cropRaster(erode(paddedRegion(region, box, r), r), {
    x: r,
    y: r,
    w: box.w,
    h: box.h,
  });
  const blurred = await sharp(Buffer.from(eroded.data), {
    raw: { width: box.w, height: box.h, channels: 1 },
  })
    .blur(Math.max(0.3, feather / 4))
    .extractChannel(0)
    .raw()
    .toBuffer();
  const inRegion = cropRaster(region, box).data;
  const alpha = new Uint8Array(blurred.length);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = inRegion[i] ? blurred[i] : 0;
  return alpha;
}

export interface Recomposed {
  /** Cena inteira com o recorte recomposto. */
  final: Img;
  alpha: Uint8Array;
  /** SSIM da faixa de transição; `null` sem janelas. */
  seamSsim: number | null;
}

/** final = original·(1−α) + bruta·α dentro do recorte; fora do recorte a cena é a original. */
export async function recompose(
  original: Img,
  raw: Img,
  box: Box,
  blend: { region: Raster; feather: number },
): Promise<Recomposed> {
  const { region, feather } = blend;
  if (raw.width !== box.w || raw.height !== box.h) {
    throw new Error('A saída bruta deve ter o tamanho do recorte');
  }
  const base = cropImg(original, box.x, box.y, box.w, box.h);
  const alpha = await featherAlpha(region, box, feather);
  const blended = new Uint8Array(base.data.length);
  for (let i = 0; i < alpha.length; i += 1) {
    const a = alpha[i];
    for (let c = 0; c < 3; c += 1) {
      // round(v / 255) com v inteiro = floor((2v + 255) / 510)
      blended[i * 3 + c] =
        (2 * (base.data[i * 3 + c] * (255 - a) + raw.data[i * 3 + c] * a) + 255) / 510;
    }
  }
  const patch: Img = { width: box.w, height: box.h, data: blended };
  return {
    final: pasteImg(original, patch, box.x, box.y),
    alpha,
    seamSsim: seamSsim(patch, raw, alpha),
  };
}

/** Conferência byte a byte: fora da região, o final tem de ser idêntico ao original. */
export function verifyOutside(original: Img, final: Img, region: Raster): void {
  let mismatched = 0;
  for (let i = 0; i < region.data.length; i += 1) {
    if (region.data[i]) continue;
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
