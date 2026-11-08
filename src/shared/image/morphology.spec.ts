import { dilate, dilateBinary, erode, erodeBinary } from './morphology';
import { emptyRaster, Raster } from './raster';

/** Implementação antiga dos comerciais (O(n·r)), copiada só como referência de valores. */
function oldDilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const line = (
    source: Uint8Array,
    target: Uint8Array,
    start: number,
    stride: number,
    length: number,
  ) => {
    for (let p = 0; p < length; p++) {
      let hit = 0;
      const to = Math.min(length - 1, p + radius);
      for (let k = Math.max(0, p - radius); k <= to && !hit; k++) {
        hit = source[start + k * stride] ? 1 : 0;
      }
      target[start + p * stride] = hit;
    }
  };
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) line(mask, horizontal, y * width, 1, width);
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) line(horizontal, out, x, width, height);
  return out;
}

function oldErode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const inverse = mask.map((v) => (v ? 0 : 1));
  return oldDilate(inverse, width, height, radius).map((v) => (v ? 0 : 1));
}

/** Máscara pseudoaleatória estável (blocos ligados). */
function noisyMask(width: number, height: number, seed: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  for (let blob = 0; blob < 12; blob++) {
    const cx = Math.floor(next() * width);
    const cy = Math.floor(next() * height);
    const rw = 2 + Math.floor(next() * 14);
    const rh = 2 + Math.floor(next() * 14);
    for (let y = Math.max(0, cy - rh); y < Math.min(height, cy + rh); y++) {
      for (let x = Math.max(0, cx - rw); x < Math.min(width, cx + rw); x++) mask[y * width + x] = 1;
    }
  }
  return mask;
}

describe('morfologia O(n) com adaptador 0/1', () => {
  it.each([0, 1, 3, 6, 11])(
    'dá os mesmos valores da implementação dos comerciais (raio %i)',
    (r) => {
      for (const [w, h, seed] of [
        [40, 30, 1],
        [33, 57, 2],
        [64, 64, 3],
      ]) {
        const mask = noisyMask(w, h, seed);
        expect(Array.from(dilateBinary(mask, w, h, r))).toEqual(
          Array.from(oldDilate(mask, w, h, r)),
        );
        expect(Array.from(erodeBinary(mask, w, h, r))).toEqual(Array.from(oldErode(mask, w, h, r)));
      }
    },
  );

  it('raio maior que a imagem: a dilatação preenche e a erosão esvazia', () => {
    const mask = new Uint8Array(5 * 5);
    mask[12] = 1;
    expect(Array.from(dilateBinary(mask, 5, 5, 9)).every((v) => v === 1)).toBe(true);
    expect(Array.from(erodeBinary(mask, 5, 5, 9)).every((v) => v === 0)).toBe(true);
  });

  it('aceita valores não nulos como ligados e devolve 0/1', () => {
    expect(Array.from(dilateBinary(Uint8Array.from([0, 255, 0]), 3, 1, 1))).toEqual([1, 1, 1]);
  });

  it('a erosão trata o fora da imagem como preenchido (a borda não come a forma)', () => {
    const full = new Uint8Array(6 * 6).fill(1);
    expect(Array.from(erodeBinary(full, 6, 6, 2))).toEqual(Array.from(full));
  });

  it('versão raster 0/255 devolve 0/255 no mesmo formato', () => {
    const raster: Raster = emptyRaster(8, 8);
    raster.data[3 * 8 + 3] = 255;
    const grown = dilate(raster, 1);
    expect(grown.width).toBe(8);
    expect(new Set(grown.data)).toEqual(new Set([0, 255]));
    expect(grown.data.filter((v) => v === 255)).toHaveLength(9);
    expect(erode(grown, 1).data.filter((v) => v === 255)).toHaveLength(1);
  });

  it('raio 77 em 1920x3840 termina em menos de 2 s (dilatação e erosão)', () => {
    const w = 1920;
    const h = 3840;
    const mask = noisyMask(w, h, 7);
    const started = Date.now();
    const grown = dilateBinary(mask, w, h, 77);
    const eroded = erodeBinary(mask, w, h, 77);
    const elapsed = Date.now() - started;
    expect(grown.length).toBe(w * h);
    expect(eroded.length).toBe(w * h);
    expect(elapsed).toBeLessThan(2000);
  });
});
