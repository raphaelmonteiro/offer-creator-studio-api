import { areaOf, bboxOf, cropRaster, emptyRaster, resizeRaster, subtract, union } from './raster';

function filled(
  width: number,
  height: number,
  box: { x: number; y: number; w: number; h: number },
) {
  const raster = emptyRaster(width, height);
  for (let y = box.y; y < box.y + box.h; y++) {
    raster.data.fill(255, y * width + box.x, y * width + box.x + box.w);
  }
  return raster;
}

describe('raster', () => {
  it('área e caixa envolvente', () => {
    const raster = filled(10, 10, { x: 2, y: 3, w: 4, h: 2 });
    expect(areaOf(raster)).toBe(8);
    expect(bboxOf(raster)).toEqual({ x: 2, y: 3, w: 4, h: 2 });
    expect(bboxOf(emptyRaster(4, 4))).toBeNull();
  });

  it('recorte, união e subtração', () => {
    const a = filled(10, 10, { x: 0, y: 0, w: 5, h: 5 });
    const b = filled(10, 10, { x: 3, y: 3, w: 5, h: 5 });
    expect(areaOf(union(a, b))).toBe(25 + 25 - 4);
    expect(areaOf(subtract(a, b))).toBe(21);
    expect(areaOf(cropRaster(a, { x: 0, y: 0, w: 5, h: 5 }))).toBe(25);
  });

  it('redimensiona por vizinho mais próximo', () => {
    const a = filled(4, 4, { x: 0, y: 0, w: 2, h: 4 });
    const big = resizeRaster(a, 8, 8);
    expect(areaOf(big)).toBe(32);
    expect(resizeRaster(a, 4, 4)).toBe(a);
  });
});
