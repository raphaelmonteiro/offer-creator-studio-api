import { CUSTOM_SIZE_LIMITS } from '../../../shared/image/openai-image-capabilities';
import { Box } from '../../../shared/image/raster';

/**
 * Recorte da região autorizada (porte de `crop.ts` do spike, PV-20): lados múltiplos de 16, área
 * mínima de 655.360 px, redução acima de 1024x1024 (a saída é ampliada de volta), esticamento do lado
 * menor até 1,10 quando a imagem é baixa ou estreita demais, e recorte sempre preso à imagem.
 */

export const CROP_EDGE = 1024;
/** Teto da distorção ao esticar o lado menor do tamanho enviado. */
export const MAX_STRETCH = 1.1;
/** Recuo da região de recomposição em relação a A, em px da SAÍDA do modelo (decisão do dono, 2026-11-02). */
export const DEFAULT_INSET_PX = 40;
const STEP = CUSTOM_SIZE_LIMITS.multiple;
const MIN_AREA = CUSTOM_SIZE_LIMITS.minPixels;

export interface CropPlan {
  /** Caixa do recorte na cena (lados múltiplos de 16). */
  box: Box;
  /** Tamanho enviado ao modelo (≤ 1024 por lado, múltiplos de 16). */
  sendW: number;
  sendH: number;
  scale: number;
  /** O recorte cresceu em volta da região até a área mínima. */
  grown: boolean;
  /** O recorte foi reduzido para caber em 1024x1024 e a saída é ampliada de volta. */
  downscaled: boolean;
  /** Não foi possível chegar à área mínima (imagem pequena demais). */
  belowMinArea: boolean;
  /** O tamanho enviado foi esticado no lado menor para atingir a área mínima. */
  stretched: boolean;
  /** Fator de esticamento do lado menor (1 = sem distorção). */
  stretchFactor: number;
}

const ceil16 = (n: number): number => Math.ceil(n / STEP) * STEP;
const floor16 = (n: number): number => Math.floor(n / STEP) * STEP;
const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** Recuo na cena: o recuo da saída do modelo dividido pelo fator de redução do recorte. */
export function insetOnScene(scale: number, insetPx: number = DEFAULT_INSET_PX): number {
  return Math.round(insetPx / Math.min(1, scale));
}

/** Posição do recorte `size` centrado em `region`, preso à cena e contendo a região quando cabe. */
function place(size: { w: number; h: number }, scene: { w: number; h: number }, region: Box): Box {
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  let x = clamp(Math.round(cx - size.w / 2), 0, scene.w - size.w);
  let y = clamp(Math.round(cy - size.h / 2), 0, scene.h - size.h);
  x = Math.min(Math.max(x, region.x + region.w - size.w), region.x);
  y = Math.min(Math.max(y, region.y + region.h - size.h), region.y);
  return {
    x: clamp(x, 0, scene.w - size.w),
    y: clamp(y, 0, scene.h - size.h),
    w: size.w,
    h: size.h,
  };
}

/** Estica o lado menor do tamanho enviado até a área mínima, se o fator ficar sob o teto. */
function stretchSent(
  sendW: number,
  sendH: number,
): { sendW: number; sendH: number; factor: number } {
  const small = Math.min(sendW, sendH);
  const large = Math.max(sendW, sendH);
  const need = Math.min(CROP_EDGE, ceil16(MIN_AREA / large));
  const factor = need / small;
  if (need > small && factor <= MAX_STRETCH && large * need >= MIN_AREA) {
    return sendW <= sendH ? { sendW: need, sendH, factor } : { sendW, sendH: need, factor };
  }
  return { sendW, sendH, factor: 1 };
}

/**
 * Recorte de uma região autorizada `region` (caixa de A) numa cena W x H: lados múltiplos de 16,
 * crescimento igual para os lados até a área mínima, preso à imagem, e redução quando passa de
 * 1024x1024.
 */
export function computeCrop(W: number, H: number, region: Box): CropPlan {
  let w = Math.min(ceil16(region.w), floor16(W));
  let h = Math.min(ceil16(region.h), floor16(H));
  const scale = Math.min(1, CROP_EDGE / Math.max(w, h));
  const capLimit = floor16(CROP_EDGE / scale);
  const capW = Math.min(floor16(W), capLimit);
  const capH = Math.min(floor16(H), capLimit);
  const sent = (cw: number, ch: number): [number, number] => [
    Math.min(CROP_EDGE, ceil16(cw * scale)),
    Math.min(CROP_EDGE, ceil16(ch * scale)),
  ];
  const startW = w;
  const startH = h;
  while (sent(w, h)[0] * sent(w, h)[1] < MIN_AREA && (w < capW || h < capH)) {
    w = Math.min(capW, w + STEP);
    h = Math.min(capH, h + STEP);
  }
  const [grownW, grownH] = sent(w, h);
  // Imagem baixa ou estreita demais para o recorte crescer: estica o LADO MENOR até a área mínima,
  // com teto de distorção. Acima do teto, fica `belowMinArea` em vez de distorcer demais.
  const stretch =
    grownW * grownH < MIN_AREA
      ? stretchSent(grownW, grownH)
      : { sendW: grownW, sendH: grownH, factor: 1 };
  return {
    box: place({ w, h }, { w: W, h: H }, region),
    sendW: stretch.sendW,
    sendH: stretch.sendH,
    scale,
    grown: w > startW || h > startH,
    downscaled: scale < 1,
    belowMinArea: stretch.sendW * stretch.sendH < MIN_AREA,
    stretched: stretch.factor > 1,
    stretchFactor: stretch.factor,
  };
}
