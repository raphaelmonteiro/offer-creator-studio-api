/** Máscaras binárias (0/255) em um buffer por imagem, e as operações simples entre elas. */

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

/** Quantidade de pixels ligados. */
export function areaOf(raster: Raster): number {
  let count = 0;
  for (let i = 0; i < raster.data.length; i += 1) if (raster.data[i]) count += 1;
  return count;
}

/** Menor caixa que contém os pixels ligados, ou `null` se não houver nenhum. */
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

/** `a` sem os pixels de `b`. */
export function subtract(a: Raster, b: Raster): Raster {
  const out = emptyRaster(a.width, a.height);
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = a.data[i] && !b.data[i] ? 255 : 0;
  return out;
}

export function union(a: Raster, b: Raster): Raster {
  const out = emptyRaster(a.width, a.height);
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = a.data[i] || b.data[i] ? 255 : 0;
  return out;
}
