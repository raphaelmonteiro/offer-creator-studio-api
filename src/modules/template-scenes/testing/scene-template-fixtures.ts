import * as sharp from 'sharp';
import { SceneElement } from '../domain/scene.types';

export type Rgb = [number, number, number];

/** Imagem de uma cor só (PNG). */
export function solidPng(width: number, height: number, color: Rgb, alpha = 1): Promise<Buffer> {
  const [r, g, b] = color;
  return sharp({ create: { width, height, channels: 4, background: { r, g, b, alpha } } })
    .png()
    .toBuffer();
}

/**
 * Master em três faixas de cor pelas zonas de `folheto-27x54` (cabeçalho vermelho, miolo verde, rodapé azul),
 * com os limites exatos de `sectionBands`. Mede o alinhamento das fatias lendo os pixels.
 */
export async function stripedMaster(
  width: number,
  height: number,
  bands: { headerPx: number; footerPx: number },
): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const color: Rgb =
      y < bands.headerPx
        ? [220, 20, 20]
        : y >= height - bands.footerPx
          ? [20, 20, 220]
          : [20, 200, 20];
    for (let x = 0; x < width; x += 1) data.set(color, (y * width + x) * 3);
  }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** Cor (RGB) do pixel de uma imagem decodificada. */
export async function pixelOf(image: Buffer, x: number, y: number): Promise<Rgb> {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (Math.round(y) * info.width + Math.round(x)) * 3;
  return [data[i], data[i + 1], data[i + 2]];
}

export const near = (a: Rgb, b: Rgb, tolerance = 14): boolean =>
  a.every((value, index) => Math.abs(value - b[index]) <= tolerance);

export function layer(overrides: Partial<SceneElement> & { id: string }): SceneElement {
  return {
    kind: 'text',
    name: overrides.id,
    x: 0.5,
    y: 0.5,
    w: 0.3,
    aspect: 2,
    rotation: 0,
    z: 1,
    ...overrides,
  };
}
