import { McNormalizedBox } from './mc-mouth-gate';
import { clampRect, McPixelRect } from './mc-tile';

/**
 * Tile de corpo do kit (change video-mascote-transparente, D4 / spec
 * video-character-framing): recorte da identidade já com alfa pela caixa da
 * figura (cabeça, mãos e objeto segurado), com margem, sem encostar nas bordas
 * de cima e dos lados, e com o rosto >= `MC_BODY_TILE_MIN_FACE_FRACTION` da
 * altura. Função pura sobre o canal alfa; o service aplica com sharp.
 */

export const MC_BODY_TILE_MIN_FACE_FRACTION = 0.25;
export const MC_BODY_TILE_MIN_RATIO = 0.5;
export const MC_BODY_TILE_MAX_RATIO = 1;
export const MC_BODY_TILE_MIN_SHORT_SIDE = 720;
export const MC_BODY_TILE_MAX_LONG_SIDE = 1920;
const MIN_MARGIN = 16;
const MARGIN_FRACTION = 0.04;
/** Pixel da figura (descarta linhas/colunas com menos de 2 pixels, ruído). */
const FIGURE_ALPHA = 32;
const OPAQUE_ALPHA = 128;
const MIN_ROW_PIXELS = 2;
/** Fração mínima da última linha opaca para a identidade contar como cortada embaixo. */
const CUT_BOTTOM_FRACTION = 0.03;
/** Altura da figura / altura do rosto até a qual a identidade é "só busto". */
const BUST_ONLY_RATIO = 2.6;

export type McBodyTileWarningCode =
  | 'IDENTITY_BUST_ONLY'
  | 'BODY_TRIMMED_FOR_FACE'
  | 'IDENTITY_CROPPED_SIDES'
  | 'LOGO_AS_IS_NO_BODY';

export const MC_BODY_TILE_WARNING_MESSAGES: Record<McBodyTileWarningCode, string> = {
  IDENTITY_BUST_ONLY:
    'A identidade desta personagem não mostra as mãos: o enquadramento de corpo mostra só o que a imagem tem.',
  BODY_TRIMMED_FOR_FACE: 'O corpo foi encurtado por baixo para o rosto continuar legível na fala.',
  IDENTITY_CROPPED_SIDES: 'A identidade está cortada nas laterais; o corte aparece dentro do tile.',
  LOGO_AS_IS_NO_BODY:
    'O logo usado como está não tem corpo: o enquadramento de corpo é o próprio logo.',
};

export interface McBodyTilePlan {
  /** Tile no sistema de coordenadas da imagem (pode sair das bordas). */
  tile: McPixelRect;
  extract: McPixelRect;
  extend: { top: number; left: number; bottom: number; right: number };
  figure: McPixelRect;
  margin: number;
  cutAtBottom: boolean;
  faceFraction: number;
  faceBelowMinimum: boolean;
  ratio: number;
  scale: number;
  output: { width: number; height: number };
  warnings: McBodyTileWarningCode[];
}

export type McBodyTilePlanResult =
  | { ok: true; plan: McBodyTilePlan }
  | { ok: false; code: 'BODY_TILE_FIGURE_NOT_FOUND' };

/** Caixa da figura: alfa >= 32, ignorando linhas e colunas com menos de 2 pixels opacos. */
export function findFigureBox(
  alpha: Uint8Array,
  width: number,
  height: number,
): McPixelRect | null {
  const rows = new Uint32Array(height);
  const cols = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] >= FIGURE_ALPHA) {
        rows[y] += 1;
        cols[x] += 1;
      }
    }
  }
  const first = (counts: Uint32Array): number => counts.findIndex((n) => n >= MIN_ROW_PIXELS);
  const last = (counts: Uint32Array): number => {
    for (let i = counts.length - 1; i >= 0; i--) if (counts[i] >= MIN_ROW_PIXELS) return i;
    return -1;
  };
  const top = first(rows);
  const left = first(cols);
  if (top < 0 || left < 0) return null;
  const bottom = last(rows);
  const right = last(cols);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/** Identidade termina cortada embaixo: >= 3% da largura da última linha é opaca. */
export function identityCutAtBottom(alpha: Uint8Array, width: number, height: number): boolean {
  let opaque = 0;
  for (let x = 0; x < width; x++) {
    if (alpha[(height - 1) * width + x] >= OPAQUE_ALPHA) opaque += 1;
  }
  return opaque / width >= CUT_BOTTOM_FRACTION;
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Encurta por baixo até o rosto chegar à fração mínima, sem nunca cortar a cabeça. */
function trimForFace(
  edges: Edges,
  face: { bottom: number; height: number },
  margin: number,
): { edges: Edges; trimmed: boolean } {
  const height = edges.bottom - edges.top;
  if (face.height / height >= MC_BODY_TILE_MIN_FACE_FRACTION) return { edges, trimmed: false };
  const target = Math.max(
    Math.ceil(face.height / MC_BODY_TILE_MIN_FACE_FRACTION),
    Math.ceil(face.bottom + margin - edges.top),
  );
  if (target >= height) return { edges, trimmed: false };
  return { edges: { ...edges, bottom: edges.top + target }, trimmed: true };
}

/** Proporção em [0,5; 1,0]: estreito ganha folga dos lados; largo ganha folga em cima. */
function fitRatio(edges: Edges): Edges {
  const w = edges.right - edges.left;
  const h = edges.bottom - edges.top;
  if (w / h < MC_BODY_TILE_MIN_RATIO) {
    const extra = Math.ceil(h * MC_BODY_TILE_MIN_RATIO) - w;
    const half = Math.floor(extra / 2);
    return { ...edges, left: edges.left - half, right: edges.right + (extra - half) };
  }
  if (w / h > MC_BODY_TILE_MAX_RATIO) return { ...edges, top: edges.top - (w - h) };
  return edges;
}

function outputSize(tile: McPixelRect): { scale: number; width: number; height: number } {
  const short = Math.min(tile.width, tile.height);
  const long = Math.max(tile.width, tile.height);
  let scale = 1;
  if (short < MC_BODY_TILE_MIN_SHORT_SIDE) scale = MC_BODY_TILE_MIN_SHORT_SIDE / short;
  else if (long > MC_BODY_TILE_MAX_LONG_SIDE) scale = MC_BODY_TILE_MAX_LONG_SIDE / long;
  return {
    scale,
    width: Math.round(tile.width * scale),
    height: Math.round(tile.height * scale),
  };
}

/** Plano do tile de corpo a partir do alfa da identidade e da caixa do rosto (normalizada). */
export function planBodyTile(input: {
  width: number;
  height: number;
  alpha: Uint8Array;
  bbox: McNormalizedBox;
}): McBodyTilePlanResult {
  const { width, height, alpha, bbox } = input;
  const figure = findFigureBox(alpha, width, height);
  if (!figure) return { ok: false, code: 'BODY_TILE_FIGURE_NOT_FOUND' };
  const cutAtBottom = identityCutAtBottom(alpha, width, height);
  const margin = Math.max(
    MIN_MARGIN,
    Math.round(MARGIN_FRACTION * Math.max(figure.width, figure.height)),
  );
  const faceH = Math.max(1, bbox.h * height);
  const face = { bottom: (bbox.y + bbox.h) * height, height: faceH };
  const initial: Edges = {
    left: figure.left - margin,
    top: figure.top - margin,
    right: figure.left + figure.width + margin,
    bottom: cutAtBottom ? height : figure.top + figure.height + margin,
  };
  const trim = trimForFace(initial, face, margin);
  const edges = fitRatio(trim.edges);
  const tile: McPixelRect = {
    left: edges.left,
    top: edges.top,
    width: edges.right - edges.left,
    height: edges.bottom - edges.top,
  };
  const extract = clampRect(tile, width, height);
  const out = outputSize(tile);
  const faceFraction = faceH / tile.height;
  const warnings: McBodyTileWarningCode[] = [];
  if (cutAtBottom && figure.height / faceH <= BUST_ONLY_RATIO) warnings.push('IDENTITY_BUST_ONLY');
  if (trim.trimmed) warnings.push('BODY_TRIMMED_FOR_FACE');
  if (figure.left <= 0 || figure.left + figure.width >= width) {
    warnings.push('IDENTITY_CROPPED_SIDES');
  }
  return {
    ok: true,
    plan: {
      tile,
      extract,
      extend: {
        top: extract.top - tile.top,
        left: extract.left - tile.left,
        bottom: tile.top + tile.height - (extract.top + extract.height),
        right: tile.left + tile.width - (extract.left + extract.width),
      },
      figure,
      margin,
      cutAtBottom,
      faceFraction,
      faceBelowMinimum: faceFraction < MC_BODY_TILE_MIN_FACE_FRACTION,
      ratio: tile.width / tile.height,
      scale: out.scale,
      output: { width: out.width, height: out.height },
      warnings,
    },
  };
}
