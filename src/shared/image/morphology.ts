import { Raster } from './raster';

/**
 * Morfologia binária de janela quadrada, separável e O(n) por raio (somas de prefixo nas linhas e
 * contadores deslizantes nas colunas, sempre em ordem de linha). Implementação única do app (DT-10): a
 * recomposição da cena (raio de cerca de 77 px em 1920x3840) e o recorte dos comerciais usam a mesma.
 * A borda da imagem conta como preenchida na erosão e como vazia na dilatação.
 */

/**
 * Para cada pixel, 1 se existe na janela `(2r+1)²` (cortada pela imagem) algum pixel cujo valor
 * (ligado ou desligado, conforme `wanted`) é o procurado; senão 0.
 */
function anyInWindow(
  src: Uint8Array,
  width: number,
  height: number,
  r: number,
  wanted: 0 | 1,
): Uint8Array {
  const bit = (value: number): number => ((value ? 1 : 0) === wanted ? 1 : 0);
  const rows = new Uint8Array(src.length);
  const prefix = new Uint32Array(width + 1);
  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    for (let x = 0; x < width; x += 1) prefix[x + 1] = prefix[x] + bit(src[base + x]);
    for (let x = 0; x < width; x += 1) {
      const lo = x > r ? x - r : 0;
      const hi = x + r < width - 1 ? x + r : width - 1;
      rows[base + x] = prefix[hi + 1] - prefix[lo] > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(src.length);
  const counts = new Uint32Array(width);
  const lastInitial = Math.min(height - 1, r);
  for (let y = 0; y <= lastInitial; y += 1) {
    for (let x = 0; x < width; x += 1) counts[x] += rows[y * width + x];
  }
  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    for (let x = 0; x < width; x += 1) out[base + x] = counts[x] > 0 ? 1 : 0;
    const entering = y + r + 1;
    if (entering < height) {
      for (let x = 0; x < width; x += 1) counts[x] += rows[entering * width + x];
    }
    const leaving = y - r;
    if (leaving >= 0) {
      for (let x = 0; x < width; x += 1) counts[x] -= rows[leaving * width + x];
    }
  }
  return out;
}

const copyBinary = (mask: Uint8Array): Uint8Array => mask.map((value) => (value ? 1 : 0));

/** Dilatação por `radius` px de uma máscara 0/1 (adaptador dos comerciais). */
export function dilateBinary(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  return radius <= 0 ? copyBinary(mask) : anyInWindow(mask, width, height, radius, 1);
}

/** Erosão por `radius` px de uma máscara 0/1 (adaptador dos comerciais); a erosão é o complemento da dilatação do complemento. */
export function erodeBinary(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return copyBinary(mask);
  return anyInWindow(mask, width, height, radius, 0).map((hit) => (hit ? 0 : 1));
}

const toRaster = (source: Raster, bits: Uint8Array): Raster => ({
  width: source.width,
  height: source.height,
  data: bits.map((bit) => (bit ? 255 : 0)),
});

/** Dilatação quadrada por `r` px de um raster 0/255. */
export function dilate(raster: Raster, r: number): Raster {
  return toRaster(raster, dilateBinary(raster.data, raster.width, raster.height, r));
}

/** Erosão quadrada por `r` px de um raster 0/255; o que está fora da imagem conta como preenchido. */
export function erode(raster: Raster, r: number): Raster {
  return toRaster(raster, erodeBinary(raster.data, raster.width, raster.height, r));
}
