import { ssimGray } from './ssim';

const W = 32;
const H = 32;
const flat = (value: number) => new Uint8Array(W * H).fill(value);
const bars = () => Uint8Array.from({ length: W * H }, (_v, i) => ((i % W) % 8 < 4 ? 40 : 220));

describe('ssimGray', () => {
  it('imagens iguais dão 1', () => {
    expect(ssimGray(bars(), bars(), W, H)).toBeCloseTo(1, 6);
  });

  it('imagens bem diferentes dão bem menos que 1', () => {
    expect(ssimGray(bars(), flat(128), W, H)).toBeLessThan(0.5);
  });

  it('sem nenhuma janela inteira vale 1 (semântica dos comerciais)', () => {
    expect(ssimGray(new Uint8Array(4), new Uint8Array(4), 2, 2)).toBe(1);
  });

  it('janela configurável', () => {
    expect(ssimGray(bars(), bars(), W, H, 16)).toBeCloseTo(1, 6);
  });
});
