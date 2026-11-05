import * as sharp from 'sharp';
import { Img, loadRgb } from '../../../shared/image/rgb';

/** Cena sintética determinística (degradês e listras): tem textura, então a diferença é mensurável. */
export async function syntheticScenePng(width: number, height: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = ((x >> 3) + (y >> 3)) % 2 === 0 ? 90 : 160;
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/**
 * "Saída do modelo": o recorte enviado com a área marcada pintada de uma cor sólida e uma faixa
 * preta na borda (o que o M3 devolve fora da região editável), no tamanho `sent`.
 */
export async function fakeModelOutput(
  sentPng: Buffer,
  paint: { x: number; y: number; w: number; h: number; color: [number, number, number] },
  blackEdgePx = 0,
): Promise<Buffer> {
  const img: Img = await loadRgb(sentPng);
  const data = Buffer.from(img.data);
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const i = (y * img.width + x) * 3;
      const inside = x >= paint.x && x < paint.x + paint.w && y >= paint.y && y < paint.y + paint.h;
      const edge =
        x < blackEdgePx ||
        y < blackEdgePx ||
        x >= img.width - blackEdgePx ||
        y >= img.height - blackEdgePx;
      const color = edge ? [0, 0, 0] : inside ? paint.color : null;
      if (color) data.set(color, i);
    }
  }
  return sharp(data, { raw: { width: img.width, height: img.height, channels: 3 } })
    .png()
    .toBuffer();
}
