import { McNormalizedBox } from './mc-mouth-gate';

/**
 * Geometria do tile do personagem (change video-formatos-personagem, D1 /
 * spec "Tile do personagem"): recorte da identidade pela caixa do rosto que o
 * gate de boca devolveu, com margem para o rosto ocupar ≥ 60% da altura,
 * estendido a uma proporção entre 1:1 e 3:4 e com ≥ 720 px no lado menor.
 * Função pura, sem sharp: o service aplica o plano com extract/extend/resize
 * e chama `edgeUniformity` sobre os pixels crus para a guarda da borda.
 */

export const MC_TILE_MIN_FACE_FRACTION = 0.6;
/** Proporção largura/altura mínima (3:4) e máxima (1:1) do tile. */
export const MC_TILE_MIN_RATIO = 0.75;
export const MC_TILE_MAX_RATIO = 1;
export const MC_TILE_MIN_SHORT_SIDE = 720;
/** Espaço acima do rosto, fração da altura do tile (o resto da folga vai para baixo: ombros). */
export const MC_TILE_HEADROOM = 0.12;

export interface McPixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface McTileCropPlan {
  /** Tile no sistema de coordenadas da imagem (pode sair das bordas). */
  tile: McPixelRect;
  /** Região efetivamente extraída da imagem (interseção tile ∩ imagem). */
  extract: McPixelRect;
  /** Preenchimento por lado para completar o tile além das bordas da imagem. */
  extend: { top: number; left: number; bottom: number; right: number };
  /** Altura do rosto / altura do tile; null sem caixa. */
  faceFraction: number | null;
  /** Largura / altura do tile. */
  ratio: number;
  /** Fator (≥ 1) para o lado menor chegar a MC_TILE_MIN_SHORT_SIDE. */
  scale: number;
  /** Dimensões finais após a escala. */
  output: { width: number; height: number };
}

function clampRect(rect: McPixelRect, width: number, height: number): McPixelRect {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(width, rect.left + rect.width);
  const bottom = Math.min(height, rect.top + rect.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Tile pela caixa do rosto: rosto ≥ 60% da altura (quando a largura permite), proporção 3:4..1:1. */
function tileFromFace(width: number, height: number, bbox: McNormalizedBox): McPixelRect {
  const faceW = Math.max(1, bbox.w * width);
  const faceH = Math.max(1, bbox.h * height);
  const faceLeft = bbox.x * width;
  const faceTop = bbox.y * height;
  // Altura: rosto a 60% (floor mantém a fração ≥ 60%); um rosto mais largo
  // que isso força a altura a acompanhar a largura (proporção nunca passa de
  // 1:1) e a fração cai abaixo de 60% — registrada em `faceFraction`.
  const tileH = Math.max(Math.floor(faceH / MC_TILE_MIN_FACE_FRACTION), Math.ceil(faceW));
  const tileW = Math.min(tileH, Math.ceil(Math.max(faceW, tileH * MC_TILE_MIN_RATIO)));
  const left = Math.round(faceLeft + faceW / 2 - tileW / 2);
  const top = Math.round(faceTop - tileH * MC_TILE_HEADROOM);
  return { left, top, width: tileW, height: tileH };
}

/** Sem caixa: a imagem inteira, estendida até a proporção válida mais próxima. */
function tileFromWholeImage(width: number, height: number): McPixelRect {
  const ratio = width / height;
  if (ratio > MC_TILE_MAX_RATIO) {
    return { left: 0, top: Math.round((height - width) / 2), width, height: width };
  }
  if (ratio < MC_TILE_MIN_RATIO) {
    const tileW = Math.ceil(height * MC_TILE_MIN_RATIO);
    return { left: Math.round((width - tileW) / 2), top: 0, width: tileW, height };
  }
  return { left: 0, top: 0, width, height };
}

export function computeTileCrop(input: {
  width: number;
  height: number;
  bbox: McNormalizedBox | null;
}): McTileCropPlan {
  const { width, height, bbox } = input;
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`Dimensões inválidas para o tile: ${width}×${height}`);
  }
  const tile = bbox ? tileFromFace(width, height, bbox) : tileFromWholeImage(width, height);
  const extract = clampRect(tile, width, height);
  const extend = {
    top: extract.top - tile.top,
    left: extract.left - tile.left,
    bottom: tile.top + tile.height - (extract.top + extract.height),
    right: tile.left + tile.width - (extract.left + extract.width),
  };
  const shortSide = Math.min(tile.width, tile.height);
  const scale = shortSide >= MC_TILE_MIN_SHORT_SIDE ? 1 : MC_TILE_MIN_SHORT_SIDE / shortSide;
  return {
    tile,
    extract,
    extend,
    faceFraction: bbox ? (bbox.h * height) / tile.height : null,
    ratio: tile.width / tile.height,
    scale,
    output: {
      width: Math.round(tile.width * scale),
      height: Math.round(tile.height * scale),
    },
  };
}

// ───────────────────────── guarda da borda (uniformidade) ─────────────────────────

export interface McRawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 3 | 4;
}

export interface McEdgeUniformity {
  uniform: boolean;
  /** Cor de fundo (média da borda superior); alpha 0 = fundo transparente. */
  background: { r: number; g: number; b: number; alpha: number };
  transparent: boolean;
  /** `#RRGGBB` da cor de fundo; null quando transparente. */
  hex: string | null;
  /** Fração de pixels de cada borda dentro da tolerância. */
  fractions: { top: number; left: number; right: number; bottom: number };
}

/** Distância máxima por canal (0..255) para o pixel contar como "a mesma cor de fundo". */
export const MC_TILE_EDGE_TOLERANCE = 28;
/** A borda superior precisa ser quase toda fundo; as laterais só na metade (o corpo pode sair por baixo). */
export const MC_TILE_EDGE_MIN_TOP = 0.97;
export const MC_TILE_EDGE_MIN_SIDE = 0.5;
/** Alpha abaixo disso é "transparente": o RGB do pixel é ignorado. */
const TRANSPARENT_ALPHA = 16;

type Rgba = [number, number, number, number];

function pixel(image: McRawImage, x: number, y: number): Rgba {
  const i = (y * image.width + x) * image.channels;
  const a = image.channels === 4 ? image.data[i + 3] : 255;
  if (a < TRANSPARENT_ALPHA) return [0, 0, 0, 0];
  return [image.data[i], image.data[i + 1], image.data[i + 2], a];
}

function within(a: Rgba, b: Rgba, tolerance: number): boolean {
  return (
    Math.abs(a[0] - b[0]) <= tolerance &&
    Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance &&
    Math.abs(a[3] - b[3]) <= tolerance
  );
}

function fraction(pixels: Rgba[], reference: Rgba, tolerance: number): number {
  if (pixels.length === 0) return 1;
  return pixels.filter((p) => within(p, reference, tolerance)).length / pixels.length;
}

function toHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Amostra as quatro bordas: a cor de referência é a média da borda superior
 * (num retrato a cabeça fica abaixo da margem de folga); uniforme quando a
 * borda superior é ≥ 97% fundo e cada lateral ≥ 50% (o corpo pode cruzar a
 * metade de baixo e a borda inferior). Gradiente, foto ou cenário atrás do
 * personagem reprovam.
 */
export function edgeUniformity(
  image: McRawImage,
  options: { tolerance?: number } = {},
): McEdgeUniformity {
  const tolerance = options.tolerance ?? MC_TILE_EDGE_TOLERANCE;
  const { width, height } = image;
  if (width < 2 || height < 2) throw new Error('Imagem pequena demais para amostrar a borda');
  const top: Rgba[] = [];
  const bottom: Rgba[] = [];
  const left: Rgba[] = [];
  const right: Rgba[] = [];
  for (let x = 0; x < width; x++) {
    top.push(pixel(image, x, 0));
    bottom.push(pixel(image, x, height - 1));
  }
  for (let y = 1; y < height - 1; y++) {
    left.push(pixel(image, 0, y));
    right.push(pixel(image, width - 1, y));
  }
  const reference = top
    .reduce<Rgba>(
      (acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2], acc[3] + p[3]],
      [0, 0, 0, 0],
    )
    .map((sum) => sum / top.length) as Rgba;
  const transparent = reference[3] < TRANSPARENT_ALPHA;
  const fractions = {
    top: fraction(top, reference, tolerance),
    left: fraction(left, reference, tolerance),
    right: fraction(right, reference, tolerance),
    bottom: fraction(bottom, reference, tolerance),
  };
  return {
    uniform:
      fractions.top >= MC_TILE_EDGE_MIN_TOP &&
      fractions.left >= MC_TILE_EDGE_MIN_SIDE &&
      fractions.right >= MC_TILE_EDGE_MIN_SIDE,
    background: { r: reference[0], g: reference[1], b: reference[2], alpha: reference[3] },
    transparent,
    hex: transparent ? null : `#${toHex(reference[0])}${toHex(reference[1])}${toHex(reference[2])}`,
    fractions,
  };
}

/** `#RRGGBB`/`#RRGGBBAA` → canais 0..255 (alpha 0..1 como o sharp espera); null se inválido. */
export function parseHexColor(
  value: string | null | undefined,
): { r: number; g: number; b: number; alpha: number } | null {
  if (!value || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value.trim())) return null;
  const hex = value.trim().slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, alpha };
}

/**
 * Cor dominante dos pixels OPACOS (alpha ≥ 128): `sharp().stats().dominant`
 * conta os pixels transparentes (RGB zerado) e devolve preto num logo com
 * fundo transparente. Histograma com 4 bits por canal; a cor devolvida é a
 * média dos pixels do balde mais cheio. null quando não há pixel opaco.
 */
export function dominantOpaqueColor(image: McRawImage): string | null {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  const { data, channels } = image;
  for (let i = 0; i + channels <= data.length; i += channels) {
    const a = channels === 4 ? data[i + 3] : 255;
    if (a < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (!best) return null;
  return `#${toHex(best.r / best.count)}${toHex(best.g / best.count)}${toHex(best.b / best.count)}`;
}
