import { MIN_AREA } from './formats';
import type { Box } from './morph';

export const CROP_EDGE = 1024;
const STEP = 16;

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
}

const ceil16 = (n: number): number => Math.ceil(n / STEP) * STEP;

function place(
  center: { cx: number; cy: number },
  w: number,
  h: number,
  W: number,
  H: number,
  region: Box,
): Box {
  let x = Math.min(Math.max(0, Math.round(center.cx - w / 2)), W - w);
  let y = Math.min(Math.max(0, Math.round(center.cy - h / 2)), H - h);
  x = Math.min(Math.max(x, region.x + region.w - w), region.x);
  y = Math.min(Math.max(y, region.y + region.h - h), region.y);
  return { x: Math.min(Math.max(0, x), W - w), y: Math.min(Math.max(0, y), H - h), w, h };
}

/**
 * Recorte de uma região autorizada `region` (caixa de A) numa cena W x H: lados múltiplos de 16,
 * crescimento igual para os lados até a área mínima de 655.360 px (PV-3), preso à imagem, e redução
 * quando passa de 1024x1024.
 */
export function computeCrop(W: number, H: number, region: Box): CropPlan {
  let w = Math.min(ceil16(region.w), Math.floor(W / STEP) * STEP);
  let h = Math.min(ceil16(region.h), Math.floor(H / STEP) * STEP);
  const scale = Math.min(1, CROP_EDGE / Math.max(w, h));
  const capLimit = Math.floor(CROP_EDGE / scale / STEP) * STEP;
  const capW = Math.min(Math.floor(W / STEP) * STEP, capLimit);
  const capH = Math.min(Math.floor(H / STEP) * STEP, capLimit);
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
  const center = { cx: region.x + region.w / 2, cy: region.y + region.h / 2 };
  let [sendW, sendH] = sent(w, h);
  // Imagem baixa demais para crescer o recorte (ex.: tapete largo em 3840x2128): estica o lado menor
  // do tamanho enviado até a área mínima (distorção de poucos %), em vez de o modelo recusar o tamanho.
  let stretched = false;
  if (sendW * sendH < MIN_AREA) {
    const need = Math.min(CROP_EDGE, ceil16(MIN_AREA / sendW));
    if (need > sendH && sendW * need >= MIN_AREA) {
      sendH = need;
      stretched = true;
    }
  }
  return {
    box: place(center, w, h, W, H, region),
    sendW,
    sendH,
    scale,
    grown: w > startW || h > startH,
    downscaled: scale < 1,
    belowMinArea: sendW * sendH < MIN_AREA,
    stretched,
  };
}
