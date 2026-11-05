import * as sharp from 'sharp';
import { trimToAlpha } from './scene-element-image';

async function withObject(box: { x: number; y: number; w: number; h: number }, alpha = 255) {
  const rgba = Buffer.alloc(100 * 80 * 4, 0);
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      rgba.set([200, 30, 30, alpha], (y * 100 + x) * 4);
    }
  }
  return sharp(rgba, { raw: { width: 100, height: 80, channels: 4 } })
    .png()
    .toBuffer();
}

describe('trimToAlpha', () => {
  it('recorta na caixa dos pixels visíveis e mantém o alfa', async () => {
    const trimmed = await trimToAlpha(await withObject({ x: 20, y: 10, w: 30, h: 40 }));
    expect(trimmed).toMatchObject({ width: 30, height: 40 });
    const meta = await sharp(trimmed!.png).metadata();
    expect(meta).toMatchObject({ width: 30, height: 40, hasAlpha: true });
  });

  it('ignora pixels quase transparentes (ruído do modelo)', async () => {
    const png = await withObject({ x: 20, y: 10, w: 30, h: 40 });
    const noisy = await sharp(png)
      .composite([
        {
          input: await sharp({
            create: {
              width: 1,
              height: 1,
              channels: 4,
              background: { r: 0, g: 0, b: 0, alpha: 3 / 255 },
            },
          })
            .png()
            .toBuffer(),
          left: 95,
          top: 75,
        },
      ])
      .png()
      .toBuffer();
    const trimmed = await trimToAlpha(noisy);
    expect(trimmed).toMatchObject({ width: 30, height: 40 });
  });

  it('imagem toda transparente: null', async () => {
    expect(await trimToAlpha(await withObject({ x: 0, y: 0, w: 0, h: 0 }))).toBeNull();
  });
});
