import { emptyRaster } from '../../../shared/image/raster';
import { Img } from '../../../shared/image/rgb';
import { diffRatioIn, diffRatioOutside, maxChannelDiff, seamSsim } from './scene-metrics';

const solid = (width: number, height: number, rgb: [number, number, number]): Img => {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) data.set(rgb, i * 3);
  return { width, height, data };
};

describe('maxChannelDiff', () => {
  it('é o maior |Δ| entre os canais depois do borrão', () => {
    const diff = maxChannelDiff(solid(8, 8, [10, 20, 30]), solid(8, 8, [10, 60, 25]));
    expect(new Set(diff)).toEqual(new Set([40]));
  });

  it('imagens iguais dão zero', () => {
    expect(new Set(maxChannelDiff(solid(4, 4, [1, 2, 3]), solid(4, 4, [1, 2, 3])))).toEqual(
      new Set([0]),
    );
  });
});

describe('diffRatioIn e diffRatioOutside', () => {
  const diff = Uint8Array.from([0, 0, 50, 50]);
  const area = emptyRaster(4, 1);
  area.data.set([0, 0, 255, 255]);

  it('contam só os pixels acima de τ dentro ou fora da área', () => {
    expect(diffRatioIn(diff, area)).toBe(1);
    expect(diffRatioOutside(diff, area)).toBe(0);
    expect(diffRatioIn(diff, area, 60)).toBe(0);
  });

  it('devolvem null (e não 0) quando não há pixels para medir', () => {
    expect(diffRatioIn(diff, emptyRaster(4, 1))).toBeNull();
    const all = emptyRaster(4, 1);
    all.data.fill(255);
    expect(diffRatioOutside(diff, all)).toBeNull();
  });
});

describe('seamSsim', () => {
  const size = 64;

  it('é null quando não há janela na faixa de transição', () => {
    const img = solid(size, size, [90, 90, 90]);
    expect(seamSsim(img, img, new Uint8Array(size * size).fill(255))).toBeNull();
    expect(seamSsim(img, img, new Uint8Array(size * size))).toBeNull();
  });

  it('mede só as janelas de transição: imagens iguais dão 1', () => {
    const img = solid(size, size, [90, 90, 90]);
    const alpha = new Uint8Array(size * size).fill(128);
    expect(seamSsim(img, img, alpha)).toBeCloseTo(1, 6);
  });

  it('imagens diferentes na costura dão menos que 1', () => {
    const a = solid(size, size, [90, 90, 90]);
    const b = solid(size, size, [90, 90, 90]);
    for (let i = 0; i < size * size; i += 1)
      if ((i % size) % 4 < 2) b.data.set([250, 250, 250], i * 3);
    const alpha = new Uint8Array(size * size).fill(100);
    expect(seamSsim(a, b, alpha)).toBeLessThan(0.9);
  });
});
