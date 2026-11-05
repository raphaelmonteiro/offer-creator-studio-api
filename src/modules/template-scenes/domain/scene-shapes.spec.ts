import * as sharp from 'sharp';
import { areaOf, bboxOf, Raster } from '../../../shared/image/raster';
import { computeSceneZones, findSceneFormat } from './scene-formats';
import {
  authorizedRegion,
  marginPx,
  maskShapeSvg,
  rasterizeRegion,
  renderEditMask,
  shapeAreaRatio,
} from './scene-shapes';

const W = 1000;
const H = 1000;
const zones = computeSceneZones(findSceneFormat('folheto-27x54')!);
const at = (r: Raster, x: number, y: number) => r.data[y * r.width + x];

async function alphaAt(png: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3];
}

describe('marginPx', () => {
  it('é a fração do menor lado da cena', () => {
    expect(marginPx(0.04, 1920, 3840)).toBe(77);
    expect(marginPx(0.04, 3520, 2336)).toBe(93);
  });
});

describe('rasterizeRegion', () => {
  it('retângulo', async () => {
    const s = await rasterizeRegion(
      { kind: 'rect', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 } },
      W,
      H,
    );
    expect(bboxOf(s)).toEqual({ x: 100, y: 100, w: 200, h: 300 });
    expect(areaOf(s)).toBe(200 * 300);
  });

  it('retângulo que passa da borda é cortado pela imagem', async () => {
    const s = await rasterizeRegion(
      { kind: 'rect', rect: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } },
      W,
      H,
    );
    expect(bboxOf(s)).toEqual({ x: 900, y: 900, w: 100, h: 100 });
  });

  it('zona do formato: largura toda e a altura da faixa', async () => {
    const s = await rasterizeRegion({ kind: 'zone', zone: 'header' }, 100, 1000, zones);
    const box = bboxOf(s)!;
    expect(box.x).toBe(0);
    expect(box.w).toBe(100);
    expect(box.h).toBe(Math.round(zones.header.h * 1000));
  });

  it('zona sem as zonas do formato lança', async () => {
    await expect(rasterizeRegion({ kind: 'zone', zone: 'footer' }, W, H)).rejects.toThrow(/Zona/);
  });

  it('laço: polígono preenchido, vizinho fora dele intacto', async () => {
    const s = await rasterizeRegion(
      {
        kind: 'lasso',
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.4, y: 0.2 },
          { x: 0.4, y: 0.4 },
          { x: 0.2, y: 0.4 },
        ],
      },
      W,
      H,
    );
    expect(at(s, 300, 300)).toBe(255);
    expect(at(s, 500, 300)).toBe(0);
    expect(shapeAreaRatio(s)).toBeCloseTo(0.04, 2);
  });

  it('pincel: o traço tem a largura de 2 x raio x largura da cena, com pontas redondas', async () => {
    const s = await rasterizeRegion(
      {
        kind: 'brush',
        radius: 0.02,
        strokes: [
          [
            { x: 0.2, y: 0.5 },
            { x: 0.6, y: 0.5 },
          ],
        ],
      },
      W,
      H,
    );
    expect(at(s, 400, 500)).toBe(255);
    expect(at(s, 400, 515)).toBe(255);
    expect(at(s, 400, 530)).toBe(0);
    expect(at(s, 195, 500)).toBe(255);
  });

  it('pincel de um ponto só vira um disco', async () => {
    const s = await rasterizeRegion(
      { kind: 'brush', radius: 0.05, strokes: [[{ x: 0.5, y: 0.5 }]] },
      W,
      H,
    );
    expect(at(s, 500, 500)).toBe(255);
    expect(at(s, 500, 560)).toBe(0);
  });

  it('o SVG do traço vazio não quebra', () => {
    expect(maskShapeSvg({ kind: 'brush', radius: 0.02, strokes: [[]] }, 10, 10)).toContain('<svg');
  });
});

describe('região autorizada e máscara', () => {
  it('A é S dilatada pela margem', async () => {
    const s = await rasterizeRegion(
      { kind: 'rect', rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } },
      W,
      H,
    );
    const a = authorizedRegion(s, 40);
    expect(bboxOf(a)).toEqual({ x: 360, y: 360, w: 280, h: 280 });
  });

  it('a máscara tem alfa 255 dentro de A e 0 fora, no tamanho enviado', async () => {
    const s = await rasterizeRegion(
      { kind: 'rect', rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } },
      W,
      H,
    );
    const mask = await renderEditMask(authorizedRegion(s, 40), { w: 500, h: 500 });
    const meta = await sharp(mask).metadata();
    expect([meta.width, meta.height]).toEqual([500, 500]);
    expect(await alphaAt(mask, 250, 250)).toBe(255);
    expect(await alphaAt(mask, 5, 5)).toBe(0);
  });

  it('sem tamanho, mantém o tamanho do raster', async () => {
    const s = await rasterizeRegion({ kind: 'rect', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }, 64, 64);
    const meta = await sharp(await renderEditMask(s)).metadata();
    expect([meta.width, meta.height]).toEqual([64, 64]);
  });
});
