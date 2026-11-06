import * as sharp from 'sharp';
import { RegionSpec } from './scene-shapes';
import { MaskShape, Pt, Rect, SceneZones } from './scene.types';

/** Cor do contorno da marcação (a mesma testada na Etapa 0). */
export const MARKUP_COLOR = '#e0241a';

/** Espessura do contorno em pixels: `max(5, round(min(w, h) / 240))`, 5 px em `1152x1440`. */
export function markupStrokePx(width: number, height: number): number {
  return Math.max(5, Math.round(Math.min(width, height) / 240));
}

const num = (value: number): string => value.toFixed(2);
const xy = (p: Pt, w: number, h: number): string => `${num(p.x * w)} ${num(p.y * h)}`;

function rectSvg(rect: Rect, w: number, h: number, t: number): string {
  return `<rect x="${num(rect.x * w)}" y="${num(rect.y * h)}" width="${num(rect.w * w)}" height="${num(rect.h * h)}" fill="none" stroke="${MARKUP_COLOR}" stroke-width="${t}"/>`;
}

function lassoSvg(shape: Extract<MaskShape, { kind: 'lasso' }>, w: number, h: number, t: number) {
  const points = shape.points.map((p) => xy(p, w, h).replace(' ', ',')).join(' ');
  return `<polygon points="${points}" fill="none" stroke="${MARKUP_COLOR}" stroke-width="${t}" stroke-linejoin="round"/>`;
}

/** Um traço do pincel como caminho com pontas e junções redondas; um ponto só vira um ponto redondo. */
function strokePath(stroke: Pt[], w: number, h: number, attrs: string): string {
  const points = stroke.length === 1 ? [stroke[0], stroke[0]] : stroke;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${xy(p, w, h)}`).join(' ');
  return `<path d="${d}" fill="none" ${attrs} stroke-linecap="round" stroke-linejoin="round"/>`;
}

/**
 * Pincel: contorno da área pintada, e não o traço cheio. Os traços são desenhados em vermelho com largura
 * `2r + 2t` e um `<mask>` com os mesmos traços em largura `2r` recorta o miolo, sobrando um anel de `t` px
 * em volta da união. `r` é o raio em pixels (o raio do pincel é fração da largura).
 */
function brushSvg(shape: Extract<MaskShape, { kind: 'brush' }>, w: number, h: number, t: number) {
  const radiusPx = shape.radius * w;
  const strokes = shape.strokes.filter((s) => s.length > 0);
  const outer = strokes
    .map((s) =>
      strokePath(s, w, h, `stroke="${MARKUP_COLOR}" stroke-width="${num(2 * radiusPx + 2 * t)}"`),
    )
    .join('');
  const inner = strokes
    .map((s) => strokePath(s, w, h, `stroke="#000" stroke-width="${num(2 * radiusPx)}"`))
    .join('');
  return (
    `<mask id="hole" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#fff"/>${inner}</mask>` +
    `<g mask="url(#hole)">${outer}</g>`
  );
}

function markupSvg(spec: RegionSpec, size: { w: number; h: number }, zones?: SceneZones): string {
  const { w, h } = size;
  const t = markupStrokePx(w, h);
  let body: string;
  if (spec.kind === 'rect') body = rectSvg(spec.rect, w, h, t);
  else if (spec.kind === 'zone') {
    if (!zones) throw new Error('Zona exige as zonas do formato');
    body = rectSvg(zones[spec.zone], w, h, t);
  } else if (spec.kind === 'lasso') body = lassoSvg(spec, w, h, t);
  else body = brushSvg(spec, w, h, t);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`;
}

/**
 * PNG de fundo transparente do tamanho da imagem enviada, só com o contorno `#e0241a` da forma marcada
 * (retângulo, zona, laço ou pincel), sem preencher a área. É a camada `markup` do `POST /images/edits`.
 * Zona exige as zonas do formato.
 */
export async function renderMarkup(
  spec: RegionSpec,
  width: number,
  height: number,
  zones?: SceneZones,
): Promise<Buffer> {
  return sharp(Buffer.from(markupSvg(spec, { w: width, h: height }, zones)))
    .png()
    .toBuffer();
}
