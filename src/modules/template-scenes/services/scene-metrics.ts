import { boxBlur3, Img, lumaOf } from '../../../shared/image/rgb';
import { Raster } from '../../../shared/image/raster';
import { ssimGray } from '../../../shared/image/ssim';

/** Tolerância por pixel depois do borrão 3x3 (τ medido no spike). */
export const DEFAULT_TAU = 16;

const SSIM_WINDOW = 8;
const MAX_PACKED_COLUMNS = 64;

/** max(|ΔR|,|ΔG|,|ΔB|) por pixel, depois do borrão 3x3 nas duas imagens (sem `Math.*` no laço, ver `boxBlur3`). */
export function maxChannelDiff(before: Img, after: Img): Uint8Array {
  const a = boxBlur3(before);
  const b = boxBlur3(after);
  const out = new Uint8Array(a.width * a.height);
  for (let i = 0; i < out.length; i += 1) {
    const k = i * 3;
    let d0 = a.data[k] - b.data[k];
    let d1 = a.data[k + 1] - b.data[k + 1];
    let d2 = a.data[k + 2] - b.data[k + 2];
    if (d0 < 0) d0 = -d0;
    if (d1 < 0) d1 = -d1;
    if (d2 < 0) d2 = -d2;
    const m = d0 > d1 ? d0 : d1;
    out[i] = m > d2 ? m : d2;
  }
  return out;
}

/** Fração dos pixels de `area` com diferença acima de τ; `null` quando a área não tem pixels. */
export function diffRatioIn(
  diff: Uint8Array,
  area: Raster,
  tau: number = DEFAULT_TAU,
): number | null {
  let total = 0;
  let changed = 0;
  for (let i = 0; i < diff.length; i += 1) {
    if (!area.data[i]) continue;
    total += 1;
    if (diff[i] > tau) changed += 1;
  }
  return total === 0 ? null : changed / total;
}

/** Fração dos pixels FORA de `area` com diferença acima de τ; `null` quando não há pixels fora. */
export function diffRatioOutside(
  diff: Uint8Array,
  area: Raster,
  tau: number = DEFAULT_TAU,
): number | null {
  let total = 0;
  let changed = 0;
  for (let i = 0; i < diff.length; i += 1) {
    if (area.data[i]) continue;
    total += 1;
    if (diff[i] > tau) changed += 1;
  }
  return total === 0 ? null : changed / total;
}

/** Empacota as janelas escolhidas numa grade para reaproveitar `ssimGray`. */
function packWindows(luma: Uint8Array, width: number, picks: Array<[number, number]>) {
  const cols = Math.min(picks.length, MAX_PACKED_COLUMNS);
  const rows = Math.ceil(picks.length / cols);
  const out = new Uint8Array(cols * SSIM_WINDOW * rows * SSIM_WINDOW);
  picks.forEach(([x, y], n) => {
    const ox = (n % cols) * SSIM_WINDOW;
    const oy = Math.floor(n / cols) * SSIM_WINDOW;
    for (let j = 0; j < SSIM_WINDOW; j += 1) {
      for (let i = 0; i < SSIM_WINDOW; i += 1) {
        out[(oy + j) * cols * SSIM_WINDOW + ox + i] = luma[(y + j) * width + x + i];
      }
    }
  });
  return { data: out, width: cols * SSIM_WINDOW, height: rows * SSIM_WINDOW };
}

/**
 * `seamSsim`: `ssimGray` em luma entre o recomposto e a saída bruta, só nas janelas 8x8 cujo centro
 * cai na faixa de transição do feather (0 < α < 255). `null` = nenhuma janela de transição (o
 * `ssimGray` puro devolveria 1, que se leria como "costura perfeita" sem medição).
 */
export function seamSsim(final: Img, raw: Img, alpha: Uint8Array): number | null {
  const picks: Array<[number, number]> = [];
  for (let y = 0; y + SSIM_WINDOW <= final.height; y += SSIM_WINDOW) {
    for (let x = 0; x + SSIM_WINDOW <= final.width; x += SSIM_WINDOW) {
      const a = alpha[(y + SSIM_WINDOW / 2) * final.width + x + SSIM_WINDOW / 2];
      if (a > 0 && a < 255) picks.push([x, y]);
    }
  }
  if (picks.length === 0) return null;
  const packedFinal = packWindows(lumaOf(final), final.width, picks);
  const packedRaw = packWindows(lumaOf(raw), raw.width, picks);
  return ssimGray(
    packedFinal.data,
    packedRaw.data,
    packedFinal.width,
    packedFinal.height,
    SSIM_WINDOW,
  );
}
