import * as sharp from 'sharp';
import { FOLD_FEATHER_PX, restoreFold } from './scene-fold-restore';
import { SceneGenerateResult } from '../providers/scene-image-provider';
import { SceneZones } from '../domain/scene.types';

const W = 800;
const H = 40;
const rect = { x: 0, y: 0, w: 1, h: 1 };
const zones = (fold?: SceneZones['fold']): SceneZones => ({
  header: rect,
  body: rect,
  footer: rect,
  ...(fold ? { fold } : {}),
});
const FOLD = { x: 0.4, y: 0, w: 0.1, h: 1 }; // x 320 a 400

const solid = (rgb: [number, number, number], width = W): Promise<Buffer> =>
  sharp({
    create: { width, height: H, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();

const result = (buffer: Buffer): SceneGenerateResult => ({
  buffer,
  usage: null,
  costUsd: 0.1,
  requestId: 'r',
  latencyMs: 1,
});

async function pixel(buffer: Buffer, x: number): Promise<number[]> {
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const channels = data.length / (W * H);
  return Array.from(data.subarray(x * channels, x * channels + 3));
}

describe('restoreFold (D-9)', () => {
  const target = { widthPx: W, heightPx: H, zones: zones(FOLD) };

  it('devolve a faixa da dobra da referência inteira, e o resto do resultado novo', async () => {
    const out = await restoreFold(
      target,
      await solid([255, 0, 0]),
      result(await solid([0, 0, 255])),
    );
    expect(await pixel(out.buffer, 320)).toEqual([255, 0, 0]);
    expect(await pixel(out.buffer, 360)).toEqual([255, 0, 0]);
    expect(await pixel(out.buffer, 399)).toEqual([255, 0, 0]);
    expect(await pixel(out.buffer, 100)).toEqual([0, 0, 255]);
    expect(await pixel(out.buffer, 700)).toEqual([0, 0, 255]);
  });

  it('faz a transição leve nas bordas, sem degrau duro', async () => {
    const out = await restoreFold(
      target,
      await solid([255, 0, 0]),
      result(await solid([0, 0, 255])),
    );
    const mid = await pixel(out.buffer, 320 - FOLD_FEATHER_PX / 2);
    expect(mid[0]).toBeGreaterThan(60);
    expect(mid[2]).toBeGreaterThan(60);
    expect(await pixel(out.buffer, 320 - FOLD_FEATHER_PX - 1)).toEqual([0, 0, 255]);
  });

  it('mantém custo e metadados do resultado, e ajusta ao tamanho nativo', async () => {
    const out = await restoreFold(
      target,
      await solid([255, 0, 0]),
      result(await solid([0, 0, 255], 400)),
    );
    expect(out.costUsd).toBe(0.1);
    expect(out.requestId).toBe('r');
    expect((await sharp(out.buffer).metadata()).width).toBe(W);
  });

  it('sem faixa da dobra (uma face, frente e verso) devolve o resultado como veio', async () => {
    const original = result(await solid([0, 0, 255]));
    const out = await restoreFold(
      { ...target, zones: zones() },
      await solid([255, 0, 0]),
      original,
    );
    expect(out).toBe(original);
  });
});
