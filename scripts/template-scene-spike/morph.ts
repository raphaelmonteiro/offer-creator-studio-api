/** Máscaras binárias (0/255) em um buffer por imagem, e as operações morfológicas do recorte. */

export interface Raster {
  width: number;
  height: number;
  /** 0 ou 255, uma posição por pixel (linha a linha). */
  data: Uint8Array;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function emptyRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8Array(width * height) };
}

export function areaOf(raster: Raster): number {
  let count = 0;
  for (let i = 0; i < raster.data.length; i += 1) if (raster.data[i]) count += 1;
  return count;
}

export function bboxOf(raster: Raster): Box | null {
  const { width, height, data } = raster;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!data[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function cropRaster(raster: Raster, box: Box): Raster {
  const out = emptyRaster(box.w, box.h);
  for (let y = 0; y < box.h; y += 1) {
    const from = (box.y + y) * raster.width + box.x;
    out.data.set(raster.data.subarray(from, from + box.w), y * box.w);
  }
  return out;
}

/** Quadrado de raio r: vizinhança de Chebyshev. */
function windowCounts(line: Uint8Array, r: number, outside: number): Uint32Array {
  const n = line.length;
  const prefix = new Uint32Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + (line[i] ? 1 : 0);
  const counts = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - r);
    const hi = Math.min(n - 1, i + r);
    const outsideCells = 2 * r + 1 - (hi - lo + 1);
    counts[i] = prefix[hi + 1] - prefix[lo] + (outside ? outsideCells : 0);
  }
  return counts;
}

function pass(
  src: Uint8Array,
  width: number,
  height: number,
  r: number,
  mode: 'dilate' | 'erode',
): Uint8Array {
  const full = 2 * r + 1;
  const out = new Uint8Array(src.length);
  const line = new Uint8Array(Math.max(width, height));
  const outside = mode === 'erode' ? 1 : 0;
  for (let y = 0; y < height; y += 1) {
    const row = src.subarray(y * width, (y + 1) * width);
    const counts = windowCounts(row, r, outside);
    for (let x = 0; x < width; x += 1) {
      const set = mode === 'dilate' ? counts[x] > 0 : counts[x] === full;
      out[y * width + x] = set ? 255 : 0;
    }
  }
  const result = new Uint8Array(src.length);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) line[y] = out[y * width + x];
    const counts = windowCounts(line.subarray(0, height), r, outside);
    for (let y = 0; y < height; y += 1) {
      const set = mode === 'dilate' ? counts[y] > 0 : counts[y] === full;
      result[y * width + x] = set ? 255 : 0;
    }
  }
  return result;
}

/** Dilatação quadrada por `r` px (separável). */
export function dilate(raster: Raster, r: number): Raster {
  if (r <= 0) return { ...raster, data: raster.data.slice() };
  return { ...raster, data: pass(raster.data, raster.width, raster.height, r, 'dilate') };
}

/** Erosão quadrada por `r` px; o que está fora da imagem conta como preenchido. */
export function erode(raster: Raster, r: number): Raster {
  if (r <= 0) return { ...raster, data: raster.data.slice() };
  return { ...raster, data: pass(raster.data, raster.width, raster.height, r, 'erode') };
}

/** Redimensiona por vizinho mais próximo (máscaras binárias). */
export function resizeRaster(raster: Raster, width: number, height: number): Raster {
  if (raster.width === width && raster.height === height) return raster;
  const out = emptyRaster(width, height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(raster.height - 1, Math.floor(((y + 0.5) * raster.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(raster.width - 1, Math.floor(((x + 0.5) * raster.width) / width));
      out.data[y * width + x] = raster.data[sy * raster.width + sx];
    }
  }
  return out;
}

export function subtract(a: Raster, b: Raster): Raster {
  const out = emptyRaster(a.width, a.height);
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = a.data[i] && !b.data[i] ? 255 : 0;
  return out;
}

export function intersect(a: Raster, b: Raster): Raster {
  const out = emptyRaster(a.width, a.height);
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = a.data[i] && b.data[i] ? 255 : 0;
  return out;
}
