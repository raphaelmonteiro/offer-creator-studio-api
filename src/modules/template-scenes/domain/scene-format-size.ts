import { CUSTOM_SIZE_LIMITS } from '../../../shared/image/openai-image-capabilities';
import { SceneFormatSpec } from './scene-formats';

export interface SceneNativeSize {
  width: number;
  height: number;
}

/** Limite da spec (1% de erro na proporção). */
const RATIO_TOLERANCE_LIMIT = 0.01;
/**
 * Tolerâncias tentadas em ordem: 0,25% reproduz a tabela de tamanhos do design (PV-9 do spike) e
 * 1% é o limite da spec, usado só se 0,25% não achar tamanho.
 */
const RATIO_TOLERANCE_STEPS = [0.0025, RATIO_TOLERANCE_LIMIT];

function largestWithin(ratio: number, tolerance: number): SceneNativeSize | null {
  const { multiple, maxEdge, minPixels, maxPixels } = CUSTOM_SIZE_LIMITS;
  let best: (SceneNativeSize & { area: number }) | null = null;
  for (let width = multiple; width <= maxEdge; width += multiple) {
    for (let height = multiple; height <= maxEdge; height += multiple) {
      const area = width * height;
      if (area < minPixels || area > maxPixels) continue;
      if (Math.abs(width / height - ratio) / ratio > tolerance) continue;
      if (!best || area > best.area) best = { width, height, area };
    }
  }
  return best ? { width: best.width, height: best.height } : null;
}

/** Proporção entre 1:3 e 3:1 (a que o modelo de imagem aceita). */
export function isSupportedRatio(artWidthCm: number, artHeightCm: number): boolean {
  const ratio = artWidthCm / artHeightCm;
  return ratio >= 1 / CUSTOM_SIZE_LIMITS.maxRatio && ratio <= CUSTOM_SIZE_LIMITS.maxRatio;
}

/**
 * Maior `w x h` com lados múltiplos de 16, proporção a até 1% da arte (tentando 0,25% antes), borda
 * até 3840 e área entre 655.360 e 8.294.400 px. `null` fora de 1:3 a 3:1 ou sem tamanho possível.
 */
export function nativeSceneSize(artWidthCm: number, artHeightCm: number): SceneNativeSize | null {
  if (!isSupportedRatio(artWidthCm, artHeightCm)) return null;
  const ratio = artWidthCm / artHeightCm;
  for (const tolerance of RATIO_TOLERANCE_STEPS) {
    const best = largestWithin(ratio, tolerance);
    if (best) return best;
  }
  return null;
}

const sizeCache = new Map<string, SceneNativeSize | null>();

/** Tamanho nativo do formato (memoizado: a busca varre ~57 mil pares). */
export function nativeSizeOfFormat(format: SceneFormatSpec): SceneNativeSize | null {
  if (!sizeCache.has(format.id)) {
    sizeCache.set(format.id, nativeSceneSize(format.artWidthCm, format.artHeightCm));
  }
  return sizeCache.get(format.id) ?? null;
}

/** Pixels por centímetro da arte (largura nativa / largura em cm). */
export function pixelsPerCm(size: SceneNativeSize, format: SceneFormatSpec): number {
  return Math.round((size.width / format.artWidthCm) * 10_000) / 10_000;
}
