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

/**
 * Tile pela caixa do rosto: rosto ≥ 60% da altura (quando a largura permite),
 * proporção `ratio` (3:4 por padrão; até 1:1 quando o corpo cruza as laterais).
 */
function tileFromFace(
  width: number,
  height: number,
  bbox: McNormalizedBox,
  ratio: number,
): McPixelRect {
  const faceW = Math.max(1, bbox.w * width);
  const faceH = Math.max(1, bbox.h * height);
  const faceLeft = bbox.x * width;
  const faceTop = bbox.y * height;
  // Altura: rosto a 60% (floor mantém a fração ≥ 60%); um rosto mais largo
  // que isso força a altura a acompanhar a largura (proporção nunca passa de
  // 1:1) e a fração cai abaixo de 60% — registrada em `faceFraction`.
  const tileH = Math.max(Math.floor(faceH / MC_TILE_MIN_FACE_FRACTION), Math.ceil(faceW));
  const tileW = Math.min(tileH, Math.ceil(Math.max(faceW, tileH * ratio)));
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
  /**
   * Proporção largura/altura pedida para o tile pelo rosto (clampada a
   * 3:4..1:1; default 3:4, a mais estreita). O service pede 1:1 quando o
   * corpo (ombros, capuz, cabelo) cruza as laterais do tile estreito: mesma
   * altura e mesmo rosto, só mais folga de fundo dos lados.
   */
  ratio?: number;
}): McTileCropPlan {
  const { width, height, bbox } = input;
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`Dimensões inválidas para o tile: ${width}×${height}`);
  }
  const ratio = Math.min(
    MC_TILE_MAX_RATIO,
    Math.max(MC_TILE_MIN_RATIO, input.ratio ?? MC_TILE_MIN_RATIO),
  );
  const tile = bbox ? tileFromFace(width, height, bbox, ratio) : tileFromWholeImage(width, height);
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
  /** Fração da zona da cabeça (topo de cada lateral, `MC_TILE_EDGE_HEAD_ZONE`) dentro da tolerância. */
  headZone: { left: number; right: number };
  /**
   * Fração de pixels "à deriva" em cada lateral: quase a cor de fundo, mas
   * fora da tolerância (assinatura de gradiente/vinheta, não de personagem).
   */
  drift: { left: number; right: number };
}

/** Distância máxima por canal (0..255) para o pixel contar como "a mesma cor de fundo". */
export const MC_TILE_EDGE_TOLERANCE = 28;
/** A borda superior precisa ser quase toda fundo; as laterais só na metade (o corpo pode sair por baixo). */
export const MC_TILE_EDGE_MIN_TOP = 0.97;
export const MC_TILE_EDGE_MIN_SIDE = 0.5;
/**
 * Lateral com MENOS da metade de fundo ainda passa quando é o corpo que a
 * cruza (ombros largos, capuz, cabelo — comum num busto realista com o rosto
 * a 60% da altura): a zona da cabeça (fração superior da lateral, acima dos
 * ombros) precisa ser fundo como a borda de cima, e o que cruza a lateral
 * precisa ser personagem (cor longe do fundo), não um fundo à deriva.
 */
export const MC_TILE_EDGE_HEAD_ZONE = 0.3;
/** Pixel "à deriva": distância do fundo entre a tolerância e este múltiplo dela. */
export const MC_TILE_EDGE_DRIFT_RATIO = 2.5;
/** Teto de pixels à deriva por lateral para o corpo cruzando a lateral ser aceito. */
export const MC_TILE_EDGE_MAX_DRIFT = 0.2;
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

/** Distância máxima por canal (RGBA) entre o pixel e a referência. */
function distance(a: Rgba, b: Rgba): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
    Math.abs(a[3] - b[3]),
  );
}

interface McSideUniformity {
  fraction: number;
  headZone: number;
  drift: number;
  uniform: boolean;
}

/**
 * Uma lateral (de cima para baixo): fundo em ≥ metade — ou, com o corpo
 * cruzando mais da metade, zona da cabeça limpa como a borda de cima e pouca
 * cor à deriva (um gradiente que se afasta do fundo gera uma faixa longa de
 * pixels quase-fundo; o contorno do personagem salta para longe de uma vez).
 */
function sideUniformity(
  pixels: Rgba[],
  reference: Rgba,
  tolerance: number,
  bodyMayCross: boolean,
): McSideUniformity {
  const fractionWithin = fraction(pixels, reference, tolerance);
  const headPixels = pixels.slice(0, Math.ceil(pixels.length * MC_TILE_EDGE_HEAD_ZONE));
  const headZone = fraction(headPixels, reference, tolerance);
  const outer = tolerance * MC_TILE_EDGE_DRIFT_RATIO;
  const drift =
    pixels.length === 0
      ? 0
      : pixels.filter((p) => {
          const d = distance(p, reference);
          return d > tolerance && d <= outer;
        }).length / pixels.length;
  return {
    fraction: fractionWithin,
    headZone,
    drift,
    uniform:
      fractionWithin >= MC_TILE_EDGE_MIN_SIDE ||
      (bodyMayCross && headZone >= MC_TILE_EDGE_MIN_TOP && drift <= MC_TILE_EDGE_MAX_DRIFT),
  };
}

export interface McEdgeUniformityOptions {
  tolerance?: number;
  /**
   * Personagem gerado: o corpo pode cruzar as laterais além da metade
   * (`sideUniformity`). Falso (default, e sempre no logo como está): lateral
   * precisa de ≥ metade de fundo — num logo, o que cruza a lateral pode ser
   * a própria marca cortada pelo recorte.
   */
  bodyMayCrossSides?: boolean;
}

function toHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Amostra as quatro bordas: a cor de referência é a média da borda superior
 * (num retrato a cabeça fica abaixo da margem de folga); uniforme quando a
 * borda superior é ≥ 97% fundo e cada lateral ≥ 50% (o corpo pode cruzar a
 * metade de baixo e a borda inferior) — ou, com `bodyMayCrossSides`, lateral
 * cruzada além da metade pelo corpo (ombros, capuz), quando a zona da cabeça
 * dela é fundo e o que a cruza não é cor à deriva (`sideUniformity`).
 * Gradiente, foto ou cenário atrás do personagem reprovam.
 */
export function edgeUniformity(
  image: McRawImage,
  options: McEdgeUniformityOptions = {},
): McEdgeUniformity {
  const tolerance = options.tolerance ?? MC_TILE_EDGE_TOLERANCE;
  const bodyMayCross = options.bodyMayCrossSides === true;
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
  const leftSide = sideUniformity(left, reference, tolerance, bodyMayCross);
  const rightSide = sideUniformity(right, reference, tolerance, bodyMayCross);
  const fractions = {
    top: fraction(top, reference, tolerance),
    left: leftSide.fraction,
    right: rightSide.fraction,
    bottom: fraction(bottom, reference, tolerance),
  };
  return {
    uniform: fractions.top >= MC_TILE_EDGE_MIN_TOP && leftSide.uniform && rightSide.uniform,
    background: { r: reference[0], g: reference[1], b: reference[2], alpha: reference[3] },
    transparent,
    hex: transparent ? null : `#${toHex(reference[0])}${toHex(reference[1])}${toHex(reference[2])}`,
    fractions,
    headZone: { left: leftSide.headZone, right: rightSide.headZone },
    drift: { left: leftSide.drift, right: rightSide.drift },
  };
}

// ───────────────────────── fundo liso → alfa (chroma key pela borda) ─────────────────────────

/** Fator da rampa suave: pixels entre `tolerance` e `tolerance × MC_TILE_KEY_RAMP` ganham alfa parcial. */
export const MC_TILE_KEY_RAMP = 1.5;

export interface McEdgeKeyResult {
  /** Pixels que viraram totalmente transparentes. */
  keyed: number;
  /** Pixels na rampa (alfa parcial — borda suave do personagem). */
  ramped: number;
}

/**
 * Converte o fundo liso detectado na borda em transparência, IN PLACE sobre
 * o buffer RGBA: inundação (4-conexa) a partir das quatro bordas sobre os
 * pixels cuja cor fica a até `tolerance × MC_TILE_KEY_RAMP` da referência
 * (distância máxima por canal). Dentro de `tolerance` o alfa vai a 0; na
 * rampa cai linearmente (anti-serrilhado do contorno). Pixels da MESMA cor
 * no interior do personagem (olho cinza num rosto cinza-claro) não são
 * alcançados pela inundação e sobrevivem — por isso não é um "replace color".
 * Pixels já transparentes contam como fundo (a inundação os atravessa).
 *
 * É o que torna `hasAlpha = true` real para a identidade gerada com fundo
 * opaco: o tile de fala recolore o fundo com `flatten`, que só enxerga alfa.
 */
export function keyEdgeBackground(
  image: McRawImage,
  reference: { r: number; g: number; b: number },
  tolerance: number = MC_TILE_EDGE_TOLERANCE,
): McEdgeKeyResult {
  if (image.channels !== 4) throw new Error('keyEdgeBackground exige buffer RGBA');
  const { data, width, height } = image;
  const outer = tolerance * MC_TILE_KEY_RAMP;
  const ramp = Math.max(1, outer - tolerance);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const distanceAt = (index: number): number => {
    const i = index * 4;
    if (data[i + 3] < TRANSPARENT_ALPHA) return 0;
    return Math.max(
      Math.abs(data[i] - reference.r),
      Math.abs(data[i + 1] - reference.g),
      Math.abs(data[i + 2] - reference.b),
    );
  };
  const push = (index: number): void => {
    if (visited[index]) return;
    visited[index] = 1;
    if (distanceAt(index) <= outer) queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  let keyed = 0;
  let ramped = 0;
  while (head < tail) {
    const index = queue[head++];
    const i = index * 4;
    const distance = distanceAt(index);
    if (distance <= tolerance) {
      if (data[i + 3] !== 0) keyed += 1;
      data[i + 3] = 0;
    } else {
      // rampa: alfa proporcional à distância além da tolerância, nunca acima do original
      const factor = Math.min(1, (distance - tolerance) / ramp);
      data[i + 3] = Math.round(data[i + 3] * factor);
      ramped += 1;
    }
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    if (y > 0) push(index - width);
    if (y < height - 1) push(index + width);
  }
  return { keyed, ramped };
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
