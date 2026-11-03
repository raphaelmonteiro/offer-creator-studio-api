import { maxChannelDiff, DEFAULT_TAU } from './metrics';
import type { Img } from './image';
import type { Raster } from './morph';

/** Fração de pixels de `area` alterados (max|Δ| > τ após borrão 3x3) entre duas imagens do mesmo tamanho. */
export function areaDiffRatio(a: Img, b: Img, area: Raster, tau: number = DEFAULT_TAU): number {
  const diff = maxChannelDiff(a, b);
  let total = 0;
  let changed = 0;
  for (let i = 0; i < diff.length; i += 1) {
    if (!area.data[i]) continue;
    total += 1;
    if (diff[i] > tau) changed += 1;
  }
  return total ? changed / total : 0;
}
