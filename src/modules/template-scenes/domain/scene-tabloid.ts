import {
  computeSceneZones,
  findSceneFormat,
  MAX_SECTION_FRACTION,
  SceneFormatSpec,
} from './scene-formats';
import { zoneBands } from './scene-zone-bands';
import { Rect, SceneZones } from './scene.types';

/**
 * Jornal de 4 páginas (change add-template-scene-tabloid): folha `folheto-54x40` deitada, impressa dos dois lados e
 * dobrada ao meio. Externa = página 4 (esquerda) | página 1 (direita); Interna = páginas 2 | 3. Tudo aqui é função
 * pura sobre o formato e as zonas da face; as medidas do teste pago de 2026-11-08 são fixas (3328x2480 px).
 */

export const TABLOID_FACE_KEYS = ['outer', 'inner'] as const;
export type TabloidFaceKey = (typeof TABLOID_FACE_KEYS)[number];

/** T-1: só o 54x40 nesta change; cada outro tamanho vira formato novo, em change própria. */
export const TABLOID_FORMAT_IDS: readonly string[] = ['folheto-54x40'];

export const acceptsTabloid = (formatId: string): boolean => TABLOID_FORMAT_IDS.includes(formatId);

export const isTabloidFace = (key: string | undefined): key is TabloidFaceKey =>
  key === 'outer' || key === 'inner';

/** Largura nativa de referência das medidas em px do teste (3328x2480). */
const REF_WIDTH = 3328;
const FOLD_FROM_PX = 1574;
const FOLD_TO_PX = 1754;
const HEADER_X_PX = 1780;
const LOGO_X_PX = 1800;
/** Margem do espaço da logo: 8% da altura do cabeçalho (30 px em 372). */
const LOGO_MARGIN = 0.08;

/** Passo, mínimo e máximo da altura do cabeçalho da capa, em cm (D-1, PV-T9). */
export const HEADER_STEP_CM = 2;
export const HEADER_MIN_CM = 3;

const FOLD: Rect = {
  x: FOLD_FROM_PX / REF_WIDTH,
  y: 0,
  w: (FOLD_TO_PX - FOLD_FROM_PX) / REF_WIDTH,
  h: 1,
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Teto da altura do cabeçalho em cm: o teto de 30% que já existe (12 cm no 54x40). */
export const headerMaxCm = (format: SceneFormatSpec): number =>
  round2(MAX_SECTION_FRACTION * format.printHeightCm);

/** Altura do cabeçalho da face em cm, pelas zonas dela. */
export const headerCmOf = (zones: SceneZones, format: SceneFormatSpec): number =>
  round2(zones.header.h * format.printHeightCm);

/**
 * Zonas das faces do jornal (PV-T1, PV-T2, T-4, T-5). Externa: cabeçalho só na capa (x 1780 até a borda), faixa do
 * rodapé só na contracapa (x 0 a 1574) e miolo = folha inteira (a área livre é em L e o texto a descreve). Interna:
 * só o miolo. As duas levam a faixa de segurança da dobra. `headerCm` troca a altura padrão do cabeçalho (D-1).
 */
export function tabloidZones(
  format: SceneFormatSpec,
  key: TabloidFaceKey,
  headerCm?: number,
): SceneZones {
  const base = computeSceneZones(format);
  const body: Rect = { x: 0, y: 0, w: 1, h: 1 };
  if (key === 'inner') {
    return {
      header: { x: 0, y: 0, w: 1, h: 0 },
      body,
      footer: { x: 0, y: 1, w: 1, h: 0 },
      fold: { ...FOLD },
    };
  }
  const headerX = HEADER_X_PX / REF_WIDTH;
  return {
    header: {
      x: headerX,
      y: 0,
      w: 1 - headerX,
      h: headerCm === undefined ? base.header.h : headerCm / format.printHeightCm,
    },
    body,
    footer: { x: 0, y: base.footer.y, w: FOLD_FROM_PX / REF_WIDTH, h: base.footer.h },
    fold: { ...FOLD },
  };
}

const sameRect = (a: Rect, b: Rect): boolean =>
  (['x', 'y', 'w', 'h'] as const).every((field) => Math.abs(a[field] - b[field]) < 1e-9);

/** As zonas são as mesmas? (o jsonb não guarda a ordem das chaves: compara campo a campo). */
export function sameZones(a: SceneZones, b: SceneZones): boolean {
  const names = ['header', 'body', 'footer'] as const;
  if (!names.every((name) => sameRect(a[name], b[name]))) return false;
  if (!a.fold || !b.fold) return !a.fold && !b.fold;
  return sameRect(a.fold, b.fold);
}

/** Medidas em px do jornal sobre o tamanho nativo da face, escritas pelo código nos prompts. */
export interface TabloidMeasures {
  width: number;
  height: number;
  /** O cabeçalho da capa vai de y 0 até aqui. */
  headerEnd: number;
  /** O cabeçalho começa neste x e vai até a borda direita. */
  headerX: number;
  /** A faixa do rodapé da contracapa começa neste y e vai de x 0 até `footerEndX`. */
  footerStart: number;
  footerEndX: number;
  /** Dobra (centro) e faixa de segurança. */
  foldX: number;
  foldFrom: number;
  foldTo: number;
  /** Espaço da logo: quadrado de lado `logoSize` a partir de (`logoX`, `logoY`). */
  logoX: number;
  logoY: number;
  logoSize: number;
}

export function tabloidMeasures(
  zones: SceneZones,
  size: { widthPx: number; heightPx: number },
): TabloidMeasures {
  const { widthPx: width, heightPx: height } = size;
  const fold = zones.fold ?? FOLD;
  const bands = zoneBands(zones, height);
  const margin = Math.round(LOGO_MARGIN * bands.headerEnd);
  return {
    width,
    height,
    headerEnd: bands.headerEnd,
    headerX: Math.round(zones.header.x * width),
    footerStart: bands.footerStart,
    footerEndX: Math.round(zones.footer.w * width),
    foldX: Math.round((fold.x + fold.w / 2) * width),
    foldFrom: Math.round(fold.x * width),
    foldTo: Math.round((fold.x + fold.w) * width),
    logoX: Math.round((LOGO_X_PX / REF_WIDTH) * width),
    logoY: margin,
    logoSize: bands.headerEnd - 2 * margin,
  };
}

/** A dobra registrada no template (D-3): só dado, sem elemento visível. `undefined` sem faixa da dobra. */
export function foldSourceOf(
  zones: SceneZones,
  widthPx: number,
): { xPx: number; safeFromPx: number; safeToPx: number } | undefined {
  if (!zones.fold) return undefined;
  return {
    xPx: Math.round((zones.fold.x + zones.fold.w / 2) * widthPx),
    safeFromPx: Math.round(zones.fold.x * widthPx),
    safeToPx: Math.round((zones.fold.x + zones.fold.w) * widthPx),
  };
}

/** O espaço da logo da capa em frações da folha: centro e lado (px sobre a largura e a altura). */
export function logoSpace(
  zones: SceneZones,
  size: { widthPx: number; heightPx: number },
): { centerX: number; centerY: number; sidePx: number } {
  const m = tabloidMeasures(zones, size);
  return {
    centerX: (m.logoX + m.logoSize / 2) / size.widthPx,
    centerY: (m.logoY + m.logoSize / 2) / size.heightPx,
    sidePx: m.logoSize,
  };
}

/** Zonas da face do jornal pelo formato; `null` fora do 54x40 ou da chave. */
export function tabloidFaceZonesFor(
  formatId: string,
  key: TabloidFaceKey,
  headerCm?: number,
): SceneZones | null {
  const format = findSceneFormat(formatId);
  return format && acceptsTabloid(format.id) ? tabloidZones(format, key, headerCm) : null;
}

export interface HeaderSize {
  cm?: number | null;
  direction?: 'maior' | 'menor' | null;
}

export type HeaderResize =
  /** O pedido não muda nada: a resposta é fixa, sem chamada. */
  | { kind: 'same'; cm: number; limit: 'max' | 'min' | null }
  | { kind: 'resize'; fromCm: number; toCm: number; limit: 'max' | 'min' | null }
  /** Nem tamanho nem direção: o código não sabe o que fazer. */
  | { kind: 'unclear' };

/**
 * Nova altura do cabeçalho (PV-T9): o `cm` dito, ou a atual mais ou menos 2 cm sem número; limitada a 3 e 12 cm. Igual
 * à atual: `same`. `limit` diz que o pedido passou do limite (o anúncio cita o máximo ou o mínimo).
 */
export function resolveHeaderSize(
  currentCm: number,
  size: HeaderSize | null | undefined,
  format: SceneFormatSpec,
): HeaderResize {
  const max = headerMaxCm(format);
  let wanted: number;
  if (size?.cm != null && size.cm > 0) wanted = round2(size.cm);
  else if (size?.direction) {
    wanted = currentCm + (size.direction === 'maior' ? HEADER_STEP_CM : -HEADER_STEP_CM);
  } else return { kind: 'unclear' };
  const toCm = Math.min(max, Math.max(HEADER_MIN_CM, wanted));
  const limit = wanted > max ? 'max' : wanted < HEADER_MIN_CM ? 'min' : null;
  if (Math.abs(toCm - currentCm) < 0.005) return { kind: 'same', cm: toCm, limit };
  return { kind: 'resize', fromCm: currentCm, toCm, limit };
}
