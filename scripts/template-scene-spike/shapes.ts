import * as sharp from 'sharp';
import type { FormatSpec } from './formats';
import { areaOf, dilate, emptyRaster, erode } from './morph';
import type { Box, Raster } from './morph';
import type { MaskShape, Pt, Rect, RegionSpec, ZoneName } from './types';

/** Margem em px: fração do menor lado da cena (design: provisório 4%, subconjunto 8%). */
export function marginPx(fraction: number, width: number, height: number): number {
  return Math.round(fraction * Math.min(width, height));
}

/** Zona nomeada: largura total, altura em cm de `FORMAT_SECTION_HEIGHTS` sobre a altura da arte. */
export function zoneRect(zone: ZoneName, format: FormatSpec): Rect {
  const h = (zone === 'header' ? format.headerCm : format.footerCm) / format.artHeightCm;
  return { x: 0, y: zone === 'header' ? 0 : 1 - h, w: 1, h };
}

function fillRect(raster: Raster, rect: Rect): void {
  const x0 = Math.max(0, Math.round(rect.x * raster.width));
  const y0 = Math.max(0, Math.round(rect.y * raster.height));
  const x1 = Math.min(raster.width, Math.round((rect.x + rect.w) * raster.width));
  const y1 = Math.min(raster.height, Math.round((rect.y + rect.h) * raster.height));
  for (let y = y0; y < y1; y += 1)
    raster.data.fill(255, y * raster.width + x0, y * raster.width + x1);
}

const px = (p: Pt, w: number, h: number): string =>
  `${(p.x * w).toFixed(2)},${(p.y * h).toFixed(2)}`;

/** SVG do pincel (traços com pontas e junções redondas) ou do laço (polígono, `nonzero`). */
export function maskShapeSvg(shape: MaskShape, w: number, h: number): string {
  let body: string;
  if (shape.kind === 'brush') {
    const stroke = (2 * shape.radius * w).toFixed(2);
    body = shape.strokes
      .filter((s) => s.length > 0)
      .map((s) => {
        const pts = s.length === 1 ? [s[0], s[0]] : s;
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p, w, h).replace(',', ' ')}`).join(' ');
        return `<path d="${d}" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
      })
      .join('');
  } else {
    const pts = shape.points.map((p) => px(p, w, h)).join(' ');
    body = `<polygon points="${pts}" fill="#fff" fill-rule="nonzero"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#000"/>${body}</svg>`;
}

async function rasterizeSvg(svg: string, w: number, h: number): Promise<Raster> {
  const grey = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer();
  const out = emptyRaster(w, h);
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = grey[i] >= 128 ? 255 : 0;
  return out;
}

/** Forma (S): a área pintada, rasterizada sobre a cena inteira. */
export async function rasterizeRegion(
  spec: RegionSpec,
  width: number,
  height: number,
  format?: FormatSpec,
): Promise<Raster> {
  if (spec.kind === 'rect' || spec.kind === 'zone') {
    if (spec.kind === 'zone' && !format) throw new Error('Zona exige o formato');
    const rect = spec.kind === 'rect' ? spec.rect : zoneRect(spec.zone, format as FormatSpec);
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

/** Alfa 0 onde editar (A) e 255 onde preservar, RGBA do tamanho do recorte. */
export async function renderEditMask(
  authorized: Raster,
  size?: { w: number; h: number },
): Promise<Buffer> {
  const rgba = Buffer.alloc(authorized.data.length * 4, 0);
  for (let i = 0; i < authorized.data.length; i += 1)
    rgba[i * 4 + 3] = authorized.data[i] ? 0 : 255;
  return toPng(rgba, authorized, size, 'nearest');
}

const MARKUP_FILL_ALPHA = 140;
const MARKUP_OUTLINE_PX = 3;

/** Marcação do braço `markup` (PV-8): S em magenta com alfa 140 e contorno de 3 px opaco. */
export async function renderMarkup(
  shape: Raster,
  size?: { w: number; h: number },
): Promise<Buffer> {
  const inner = erode(shape, MARKUP_OUTLINE_PX);
  const rgba = Buffer.alloc(shape.data.length * 4, 0);
  for (let i = 0; i < shape.data.length; i += 1) {
    if (!shape.data[i]) continue;
    rgba[i * 4] = 255;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = inner.data[i] ? MARKUP_FILL_ALPHA : 255;
  }
  return toPng(rgba, shape, size, 'lanczos3');
}

async function toPng(
  rgba: Buffer,
  dims: { width: number; height: number },
  size: { w: number; h: number } | undefined,
  kernel: 'nearest' | 'lanczos3',
): Promise<Buffer> {
  let img = sharp(rgba, { raw: { width: dims.width, height: dims.height, channels: 4 } });
  if (size && (size.w !== dims.width || size.h !== dims.height)) {
    img = img.resize(size.w, size.h, { kernel, fit: 'fill' });
  }
  return img.png().toBuffer();
}

export function shapeAreaRatio(shape: Raster): number {
  return areaOf(shape) / (shape.width * shape.height);
}

export type { Box };
