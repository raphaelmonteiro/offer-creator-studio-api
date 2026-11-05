import * as sharp from 'sharp';
import { dilate } from '../../../shared/image/morphology';
import { areaOf, emptyRaster, Raster } from '../../../shared/image/raster';
import { MaskShape, Pt, Rect, SceneZoneName, SceneZones } from './scene.types';

/**
 * Formas da edição local (porte de `shapes.ts` do spike): rasteriza o retângulo, a zona, o pincel e
 * o laço na cena inteira (forma S), calcula a região autorizada A e gera a máscara PNG que vai ao
 * modelo. Coordenadas normalizadas (0..1), origem no canto superior esquerdo.
 */

/** Alvo marcado pelo cliente: retângulo, zona nomeada do formato, ou pincel/laço. */
export type RegionSpec =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'zone'; zone: SceneZoneName }
  | MaskShape;

/** Alfa que a OpenAI lê como "editar" (convenção medida no spike: 255 = editar, 0 = preservar). */
export const MASK_EDIT_ALPHA = 255;

/** Margem em px: fração do menor lado da cena (4% por padrão). */
export function marginPx(fraction: number, width: number, height: number): number {
  return Math.round(fraction * Math.min(width, height));
}

function fillRect(raster: Raster, rect: Rect): void {
  const x0 = Math.max(0, Math.round(rect.x * raster.width));
  const y0 = Math.max(0, Math.round(rect.y * raster.height));
  const x1 = Math.min(raster.width, Math.round((rect.x + rect.w) * raster.width));
  const y1 = Math.min(raster.height, Math.round((rect.y + rect.h) * raster.height));
  for (let y = y0; y < y1; y += 1) {
    raster.data.fill(255, y * raster.width + x0, y * raster.width + x1);
  }
}

const point = (p: Pt, w: number, h: number): [string, string] => [
  (p.x * w).toFixed(2),
  (p.y * h).toFixed(2),
];

function brushSvg(shape: Extract<MaskShape, { kind: 'brush' }>, w: number, h: number): string {
  const stroke = (2 * shape.radius * w).toFixed(2);
  return shape.strokes
    .filter((s) => s.length > 0)
    .map((s) => {
      const pts = s.length === 1 ? [s[0], s[0]] : s;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${point(p, w, h).join(' ')}`).join(' ');
      return `<path d="${d}" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join('');
}

/** SVG do pincel (traços com pontas e junções redondas) ou do laço (polígono, `nonzero`). */
export function maskShapeSvg(shape: MaskShape, w: number, h: number): string {
  const body =
    shape.kind === 'brush'
      ? brushSvg(shape, w, h)
      : `<polygon points="${shape.points.map((p) => point(p, w, h).join(',')).join(' ')}" fill="#fff" fill-rule="nonzero"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#000"/>${body}</svg>`;
}

async function rasterizeSvg(svg: string, w: number, h: number): Promise<Raster> {
  const grey = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer();
  const out = emptyRaster(w, h);
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = grey[i] >= 128 ? 255 : 0;
  return out;
}

/** Forma (S): a área marcada, rasterizada sobre a cena inteira. Zona exige as zonas do formato. */
export async function rasterizeRegion(
  spec: RegionSpec,
  width: number,
  height: number,
  zones?: SceneZones,
): Promise<Raster> {
  if (spec.kind === 'rect' || spec.kind === 'zone') {
    if (spec.kind === 'zone' && !zones) throw new Error('Zona exige as zonas do formato');
    const rect = spec.kind === 'rect' ? spec.rect : (zones as SceneZones)[spec.zone];
    const raster = emptyRaster(width, height);
    fillRect(raster, rect);
    return raster;
  }
  return rasterizeSvg(maskShapeSvg(spec, width, height), width, height);
}

/** Região autorizada (A): S dilatada pela margem. */
export function authorizedRegion(shape: Raster, margin: number): Raster {
  return dilate(shape, margin);
}

/**
 * Máscara RGBA do tamanho do recorte: alfa 255 onde editar (A) e 0 onde preservar, redimensionada
 * por vizinho mais próximo ao tamanho enviado (`size`).
 */
export function renderEditMask(
  authorized: Raster,
  size?: { w: number; h: number },
): Promise<Buffer> {
  const rgba = Buffer.alloc(authorized.data.length * 4, 0);
  for (let i = 0; i < authorized.data.length; i += 1) {
    rgba[i * 4 + 3] = authorized.data[i] ? MASK_EDIT_ALPHA : 255 - MASK_EDIT_ALPHA;
  }
  let image = sharp(rgba, {
    raw: { width: authorized.width, height: authorized.height, channels: 4 },
  });
  if (size && (size.w !== authorized.width || size.h !== authorized.height)) {
    image = image.resize(size.w, size.h, { kernel: 'nearest', fit: 'fill' });
  }
  return image.png().toBuffer();
}

/** Fração da cena coberta pela forma. */
export function shapeAreaRatio(shape: Raster): number {
  return areaOf(shape) / (shape.width * shape.height);
}
