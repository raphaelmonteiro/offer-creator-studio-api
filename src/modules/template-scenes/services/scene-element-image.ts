import * as sharp from 'sharp';

/** Pixels com alfa abaixo disto contam como transparentes ao recortar o objeto. */
const ALPHA_THRESHOLD = 8;

export interface TrimmedImage {
  png: Buffer;
  width: number;
  height: number;
}

/**
 * Recorta o PNG transparente do "adicionar" na caixa dos pixels visíveis (alfa acima do limiar), para
 * o elemento ter o tamanho do objeto e não o da tela do modelo. `null` se a imagem veio toda transparente.
 */
export async function trimToAlpha(png: Buffer): Promise<TrimmedImage | null> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] < ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const trimmed = await sharp(png)
    .ensureAlpha()
    .extract({ left: minX, top: minY, width, height })
    .png()
    .toBuffer();
  return { png: trimmed, width, height };
}
