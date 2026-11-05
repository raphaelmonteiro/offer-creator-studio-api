import { emptyRaster } from '../../../shared/image/raster';
import { Img } from '../../../shared/image/rgb';
import { featherAlpha, recompose, RecomposeMismatchError, verifyOutside } from './scene-recompose';

const solid = (width: number, height: number, v: number): Img => ({
  width,
  height,
  data: new Uint8Array(width * height * 3).fill(v),
});

function regionOf(width: number, height: number, x0: number, y0: number, x1: number, y1: number) {
  const r = emptyRaster(width, height);
  for (let y = y0; y < y1; y += 1) r.data.fill(255, y * width + x0, y * width + x1);
  return r;
}

describe('featherAlpha', () => {
  it('é 255 no miolo da região, 0 fora dela e passa por valores intermediários na borda', async () => {
    const region = regionOf(200, 200, 50, 50, 150, 150);
    const alpha = await featherAlpha(region, { x: 0, y: 0, w: 200, h: 200 }, 24);
    expect(alpha[100 * 200 + 100]).toBe(255);
    expect(alpha[10 * 200 + 10]).toBe(0);
    const edge = alpha[100 * 200 + 52];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  it('a borda da imagem conta como região (sem escurecer o canto colado na borda)', async () => {
    const region = regionOf(100, 100, 0, 0, 60, 60);
    const alpha = await featherAlpha(region, { x: 0, y: 0, w: 100, h: 100 }, 24);
    expect(alpha[0]).toBe(255);
  });
});

describe('recompose e verifyOutside', () => {
  const original = solid(120, 120, 40);
  const raw = solid(100, 100, 200);
  const box = { x: 10, y: 10, w: 100, h: 100 };
  const region = regionOf(120, 120, 30, 30, 90, 90);

  it('troca o miolo da região, mistura na borda e não toca o resto', async () => {
    const out = await recompose(original, raw, box, region, 16);
    const at = (x: number, y: number) => out.final.data[(y * 120 + x) * 3];
    expect(at(60, 60)).toBe(200);
    expect(at(5, 5)).toBe(40);
    expect(at(31, 60)).toBeGreaterThan(40);
    expect(at(31, 60)).toBeLessThan(200);
    expect(() => verifyOutside(original, out.final, region)).not.toThrow();
    expect(out.seamSsim).not.toBeNull();
  });

  it('lança RECOMPOSE_MISMATCH com a contagem quando um pixel fora da região muda', async () => {
    const out = await recompose(original, raw, box, region, 16);
    out.final.data[0] = 41;
    out.final.data[(119 * 120 + 119) * 3 + 2] = 0;
    const error = (() => {
      try {
        verifyOutside(original, out.final, region);
      } catch (e) {
        return e as RecomposeMismatchError;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(RecomposeMismatchError);
    expect(error?.code).toBe('RECOMPOSE_MISMATCH');
    expect(error?.mismatched).toBe(2);
  });

  it('recusa saída bruta de tamanho diferente do recorte', async () => {
    await expect(recompose(original, solid(50, 50, 1), box, region, 16)).rejects.toThrow(
      /tamanho do recorte/,
    );
  });
});
