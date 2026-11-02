import { ssimGray } from '../../src/modules/commercials/domain/mc-jump-metric';
import { boxBlur3, lumaOf } from './image';
import type { Img } from './image';
import type { Raster } from './morph';

/** Tolerância por pixel após o borrão 3x3 (PV-1). */
export const DEFAULT_TAU = 16;
export const FEATHER_SWEEP = [8, 16, 24, 32, 48];
export const TAU_SWEEP = [8, 12, 16, 24, 32];

export interface DiffMetrics {
  outsideMaskDiffRatio: number;
  insideMaskDiffRatio: number;
  /** Histograma de max|Δ| (0..255) fora de A, para calibrar τ no estágio 4. */
  outsideHistogram: number[];
  pixelsOutside: number;
  pixelsInside: number;
}

/** max(|ΔR|,|ΔG|,|ΔB|) por pixel, depois do borrão 3x3 nas duas imagens. */
export function maxChannelDiff(before: Img, after: Img): Uint8Array {
  const a = boxBlur3(before);
  const b = boxBlur3(after);
  const out = new Uint8Array(a.width * a.height);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.max(
      Math.abs(a.data[i * 3] - b.data[i * 3]),
      Math.abs(a.data[i * 3 + 1] - b.data[i * 3 + 1]),
      Math.abs(a.data[i * 3 + 2] - b.data[i * 3 + 2]),
    );
  }
  return out;
}

/**
 * `outsideMaskDiffRatio`: alterados fora de A sobre o total fora de A. `insideMaskDiffRatio`: alterados
 * dentro de S sobre o total de S. Tudo no recorte enviado, na saída bruta.
 */
export function diffMetrics(
  before: Img,
  raw: Img,
  shape: Raster,
  authorized: Raster,
  tau: number = DEFAULT_TAU,
): DiffMetrics {
  const diff = maxChannelDiff(before, raw);
  const histogram = new Array<number>(256).fill(0);
  let outside = 0;
  let outsideChanged = 0;
  let inside = 0;
  let insideChanged = 0;
  for (let i = 0; i < diff.length; i += 1) {
    if (!authorized.data[i]) {
      outside += 1;
      histogram[diff[i]] += 1;
      if (diff[i] > tau) outsideChanged += 1;
    }
    if (shape.data[i]) {
      inside += 1;
      if (diff[i] > tau) insideChanged += 1;
    }
  }
  return {
    outsideMaskDiffRatio: outside ? outsideChanged / outside : 0,
    insideMaskDiffRatio: inside ? insideChanged / inside : 0,
    outsideHistogram: histogram,
    pixelsOutside: outside,
    pixelsInside: inside,
  };
}

/**
 * `seamSsim` (PV-2): `ssimGray` em luma entre o final e a saída bruta, só nas janelas 8x8 cujo centro
 * cai na faixa de transição (0 < α < 255). As janelas escolhidas são empacotadas numa grade para
 * reaproveitar a função existente. null = nenhuma janela de transição.
 */
export function seamSsim(final: Img, raw: Img, alpha: Uint8Array): number | null {
  const win = 8;
  const picks: Array<[number, number]> = [];
  for (let y = 0; y + win <= final.height; y += win) {
    for (let x = 0; x + win <= final.width; x += win) {
      const a = alpha[(y + win / 2) * final.width + x + win / 2];
      if (a > 0 && a < 255) picks.push([x, y]);
    }
  }
  if (picks.length === 0) return null;
  const cols = Math.min(picks.length, 64);
  const rows = Math.ceil(picks.length / cols);
  const pack = (luma: Uint8Array): Uint8Array => {
    const out = new Uint8Array(cols * win * rows * win);
    picks.forEach(([x, y], n) => {
      const ox = (n % cols) * win;
      const oy = Math.floor(n / cols) * win;
      for (let j = 0; j < win; j += 1) {
        for (let i = 0; i < win; i += 1)
          out[(oy + j) * cols * win + ox + i] = luma[(y + j) * final.width + x + i];
      }
    });
    return out;
  };
  return ssimGray(pack(lumaOf(final)), pack(lumaOf(raw)), cols * win, rows * win, win);
}

export function tauSweep(
  before: Img,
  raw: Img,
  shape: Raster,
  authorized: Raster,
  taus: number[] = TAU_SWEEP,
): Array<{ tau: number; insideMaskDiffRatio: number; outsideMaskDiffRatio: number }> {
  return taus.map((tau) => {
    const m = diffMetrics(before, raw, shape, authorized, tau);
    return {
      tau,
      insideMaskDiffRatio: m.insideMaskDiffRatio,
      outsideMaskDiffRatio: m.outsideMaskDiffRatio,
    };
  });
}
