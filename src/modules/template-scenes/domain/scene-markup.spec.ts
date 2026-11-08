import * as sharp from 'sharp';
import { sceneZonesFor } from './scene-formats';
import { markupStrokePx, MARKUP_COLOR, renderMarkup } from './scene-markup';
import { MaskShape } from './scene.types';

const W = 1152;
const H = 1440;

interface Pixels {
  data: Buffer;
  width: number;
  height: number;
}

async function read(png: Buffer): Promise<Pixels> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const at = (pixels: Pixels, x: number, y: number) => {
  const i = (Math.round(y) * pixels.width + Math.round(x)) * 4;
  return { r: pixels.data[i], g: pixels.data[i + 1], b: pixels.data[i + 2], a: pixels.data[i + 3] };
};

const isContour = (pixel: { r: number; g: number; b: number; a: number }) =>
  pixel.a === 255 && pixel.r === 0xe0 && pixel.g === 0x24 && pixel.b === 0x1a;
const isClear = (pixel: { a: number }) => pixel.a === 0;

function share(pixels: Pixels, predicate: (a: number) => boolean): number {
  let count = 0;
  for (let i = 3; i < pixels.data.length; i += 4) if (predicate(pixels.data[i])) count += 1;
  return count / (pixels.width * pixels.height);
}

describe('scene-markup', () => {
  it('traço: 5 px em 1152x1440, proporcional ao menor lado em tamanhos maiores', () => {
    expect(markupStrokePx(1152, 1440)).toBe(5);
    expect(markupStrokePx(1920, 3840)).toBe(8);
    expect(markupStrokePx(3520, 2336)).toBe(10);
    expect(markupStrokePx(100, 100)).toBe(5);
    expect(MARKUP_COLOR).toBe('#e0241a');
  });

  describe('Zona escolhida', () => {
    it('o retângulo da zona vira o contorno, e o miolo e o entorno ficam transparentes', async () => {
      const zones = sceneZonesFor('folheto-27x40');
      const footer = zones.footer;
      const png = await renderMarkup({ kind: 'zone', zone: 'footer' }, W, H, zones);
      const pixels = await read(png);

      expect(pixels).toMatchObject({ width: W, height: H });
      const top = footer.y * H;
      const midY = (footer.y + footer.h / 2) * H;
      expect(isContour(at(pixels, W / 2, top))).toBe(true);
      expect(isContour(at(pixels, 1, midY))).toBe(true);
      expect(isClear(at(pixels, W / 2, midY))).toBe(true);
      expect(isClear(at(pixels, W / 2, top - 30))).toBe(true);
    });

    it('zona sem as zonas do formato é erro de programação', async () => {
      await expect(renderMarkup({ kind: 'zone', zone: 'header' }, W, H)).rejects.toThrow('Zona');
    });
  });

  describe('Retângulo', () => {
    it('contorno de 5 px sobre as bordas, sem preencher', async () => {
      const png = await renderMarkup(
        { kind: 'rect', rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.4 } },
        W,
        H,
      );
      const pixels = await read(png);
      expect(isContour(at(pixels, 0.25 * W, 0.45 * H))).toBe(true);
      expect(isContour(at(pixels, 0.75 * W, 0.45 * H))).toBe(true);
      expect(isClear(at(pixels, 0.5 * W, 0.45 * H))).toBe(true);
      expect(isClear(at(pixels, 0.1 * W, 0.1 * H))).toBe(true);
      // o contorno ocupa só uma fração pequena da imagem: o fundo é transparente
      expect(share(pixels, (a) => a === 0)).toBeGreaterThan(0.97);
    });

    it('retângulo na borda da imagem não estoura o tamanho', async () => {
      const png = await renderMarkup({ kind: 'rect', rect: { x: 0, y: 0, w: 1, h: 1 } }, W, H);
      expect(await sharp(png).metadata()).toMatchObject({ width: W, height: H, hasAlpha: true });
    });
  });

  describe('Pincel e laço', () => {
    const lasso: MaskShape = {
      kind: 'lasso',
      points: [
        { x: 0.3, y: 0.3 },
        { x: 0.7, y: 0.3 },
        { x: 0.7, y: 0.6 },
        { x: 0.3, y: 0.6 },
      ],
    };

    it('laço: só o contorno do polígono, fundo transparente e miolo vazio', async () => {
      const pixels = await read(await renderMarkup(lasso, W, H));
      expect(isContour(at(pixels, 0.5 * W, 0.3 * H))).toBe(true);
      expect(isContour(at(pixels, 0.7 * W, 0.45 * H))).toBe(true);
      expect(isClear(at(pixels, 0.5 * W, 0.45 * H))).toBe(true);
      expect(isClear(at(pixels, 0.1 * W, 0.1 * H))).toBe(true);
    });

    it('pincel: contorno da área pintada, não o traço cheio', async () => {
      const radius = 0.05; // 57,6 px
      const brush: MaskShape = {
        kind: 'brush',
        radius,
        strokes: [
          [
            { x: 0.3, y: 0.5 },
            { x: 0.7, y: 0.5 },
          ],
        ],
      };
      const pixels = await read(await renderMarkup(brush, W, H));
      const r = radius * W;
      const t = markupStrokePx(W, H);
      const midX = 0.5 * W;
      const midY = 0.5 * H;
      // o eixo do traço e o miolo da área pintada ficam transparentes
      expect(isClear(at(pixels, midX, midY))).toBe(true);
      expect(isClear(at(pixels, midX, midY + r - 3))).toBe(true);
      // o anel de t px fica logo fora da borda da área pintada
      expect(isContour(at(pixels, midX, midY + r + t / 2))).toBe(true);
      expect(isContour(at(pixels, midX, midY - r - t / 2))).toBe(true);
      // fora do anel, transparente
      expect(isClear(at(pixels, midX, midY + r + t + 6))).toBe(true);
      // a ponta redonda também tem anel
      expect(isContour(at(pixels, 0.3 * W - r - t / 2, midY))).toBe(true);
      expect(isClear(at(pixels, 0.3 * W, midY))).toBe(true);
    });

    it('pincel com dois traços que se cruzam: o anel contorna a união, sem linha dentro dela', async () => {
      const brush: MaskShape = {
        kind: 'brush',
        radius: 0.04,
        strokes: [
          [
            { x: 0.3, y: 0.5 },
            { x: 0.7, y: 0.5 },
          ],
          [
            { x: 0.5, y: 0.35 },
            { x: 0.5, y: 0.65 },
          ],
        ],
      };
      const pixels = await read(await renderMarkup(brush, W, H));
      // o cruzamento está dentro da área pintada: nada de contorno ali
      expect(isClear(at(pixels, 0.5 * W, 0.5 * H))).toBe(true);
      expect(isClear(at(pixels, 0.5 * W, 0.5 * H - 0.04 * W))).toBe(true);
    });

    it('pincel de um ponto só vira um círculo contornado', async () => {
      const brush: MaskShape = { kind: 'brush', radius: 0.05, strokes: [[{ x: 0.5, y: 0.5 }]] };
      const pixels = await read(await renderMarkup(brush, W, H));
      const r = 0.05 * W;
      expect(isClear(at(pixels, 0.5 * W, 0.5 * H))).toBe(true);
      expect(isContour(at(pixels, 0.5 * W + r + 2, 0.5 * H))).toBe(true);
    });
  });
});
