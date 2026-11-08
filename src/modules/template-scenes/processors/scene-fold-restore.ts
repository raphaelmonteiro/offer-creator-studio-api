import * as sharp from 'sharp';
import { SceneGenerateResult } from '../providers/scene-image-provider';
import { SceneZones } from '../domain/scene.types';

/** Largura da transição, em px, de cada lado da faixa da dobra (a faixa em si volta inteira). */
export const FOLD_FEATHER_PX = 48;

export interface FoldTarget {
  widthPx: number;
  heightPx: number;
  zones: SceneZones;
}

const toNative = (image: Buffer, target: FoldTarget): Promise<Buffer> =>
  sharp(image)
    .resize(target.widthPx, target.heightPx, { fit: 'fill' })
    .removeAlpha()
    .png()
    .toBuffer();

/**
 * D-9: a faixa de segurança da dobra (`zones.fold`) volta da master de referência sobre o resultado da edição, com
 * uma transição leve nas duas bordas. O modelo de imagem não respeita medidas em px e o edit não tem máscara; o código
 * garante o que o prompt só pede. Sem `zones.fold` (cenas de uma face e de frente e verso), devolve o resultado como veio.
 */
export async function restoreFold(
  target: FoldTarget,
  reference: Buffer,
  result: SceneGenerateResult,
): Promise<SceneGenerateResult> {
  const { fold } = target.zones;
  if (!fold) return result;
  const { widthPx: W, heightPx: H } = target;
  const from = Math.round(fold.x * W);
  const to = Math.round((fold.x + fold.w) * W);
  const left = Math.max(0, from - FOLD_FEATHER_PX);
  const right = Math.min(W, to + FOLD_FEATHER_PX);
  const width = right - left;
  const base = await toNative(result.buffer, target);
  const patch = await sharp(await toNative(reference, target))
    .extract({ left, top: 0, width, height: H })
    .raw()
    .toBuffer();
  const alpha = Buffer.alloc(width * H);
  for (let x = 0; x < width; x += 1) {
    const px = left + x;
    const outside = px < from ? from - px : px >= to ? px - to + 1 : 0;
    const value = Math.max(0, Math.round(255 * (1 - outside / (FOLD_FEATHER_PX + 1))));
    for (let y = 0; y < H; y += 1) alpha[y * width + x] = value;
  }
  const overlay = await sharp(patch, { raw: { width, height: H, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height: H, channels: 1 } })
    .png()
    .toBuffer();
  const buffer = await sharp(base)
    .composite([{ input: overlay, left, top: 0 }])
    .png()
    .toBuffer();
  return { ...result, buffer };
}
