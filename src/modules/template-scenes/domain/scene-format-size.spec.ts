import { findSceneFormat } from './scene-formats';
import {
  isSupportedRatio,
  nativeSceneSize,
  nativeSizeOfFormat,
  pixelsPerCm,
} from './scene-format-size';

describe('scene-format-size', () => {
  it.each([
    ['folheto-27x54', 1920, 3840],
    ['folheto-55x36', 3520, 2336],
    ['revista-20x26.5', 2496, 3280],
    ['folheto-27x40', 2352, 3504],
    ['folheto-54x30', 3840, 2128],
  ])('tamanho nativo de %s', (id, width, height) => {
    expect(nativeSizeOfFormat(findSceneFormat(id)!)).toEqual({ width, height });
  });

  it('todo formato da lista tem tamanho válido para o modelo', () => {
    for (const id of [
      'revista-13x19.5',
      'folheto-54x40',
      'folheto-27x30',
      'folheto-20x27',
      'folheto-10x13',
    ]) {
      const size = nativeSizeOfFormat(findSceneFormat(id)!)!;
      expect(size.width % 16).toBe(0);
      expect(size.height % 16).toBe(0);
      expect(size.width * size.height).toBeGreaterThanOrEqual(655_360);
      expect(size.width * size.height).toBeLessThanOrEqual(8_294_400);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(3840);
    }
  });

  it('recusa proporções fora de 1:3 a 3:1 (spreads largos)', () => {
    expect(isSupportedRatio(110, 30)).toBe(false);
    expect(nativeSceneSize(110, 30)).toBeNull();
    expect(nativeSceneSize(10, 31)).toBeNull();
    expect(isSupportedRatio(30, 10)).toBe(true);
  });

  it('calcula os pixels por centímetro da largura da arte', () => {
    const format = findSceneFormat('folheto-27x54')!;
    expect(pixelsPerCm({ width: 1920, height: 3840 }, format)).toBeCloseTo(69.8182, 4);
  });
});
