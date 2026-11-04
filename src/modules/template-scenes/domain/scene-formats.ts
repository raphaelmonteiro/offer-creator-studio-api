import { Rect, SceneZones } from './scene.types';

/**
 * Formatos de impressão aceitos na cena. Medidas copiadas de `frontend/src/types/editor.ts`
 * (arte com sangria e altura impressa) e `FORMAT_SECTION_HEIGHTS` (cabeçalho e rodapé em cm).
 * Spreads, páginas duplas e formatos sociais ficam de fora (`SCENE_FORMAT_UNSUPPORTED`).
 */
export interface SceneFormatSpec {
  id: string;
  artWidthCm: number;
  artHeightCm: number;
  printHeightCm: number;
  headerCm: number;
  footerCm: number;
}

type FormatRow = [
  id: string,
  artW: number,
  artH: number,
  printH: number,
  header: number,
  footer: number,
];

const FORMAT_ROWS: FormatRow[] = [
  ['revista-20x26.5', 20.5, 27, 26.5, 6, 4],
  ['revista-13x19.5', 14, 20.5, 19.5, 4, 3],
  ['folheto-55x36', 55, 36.5, 36, 6, 4],
  ['folheto-54x40', 55, 41, 40, 6, 4],
  ['folheto-54x30', 55, 30.5, 30, 5, 3],
  ['folheto-27x54', 27.5, 55, 54, 6, 4],
  ['folheto-27x40', 27.5, 41, 40, 6, 4],
  ['folheto-27x30', 27.5, 30.5, 30, 5, 3],
  ['folheto-20x27', 20.5, 27.5, 27, 6, 4],
  ['folheto-10x13', 10.5, 13.75, 13, 3, 2],
];

export const SCENE_FORMATS: Readonly<Record<string, SceneFormatSpec>> = Object.fromEntries(
  FORMAT_ROWS.map(([id, artWidthCm, artHeightCm, printHeightCm, headerCm, footerCm]) => [
    id,
    { id, artWidthCm, artHeightCm, printHeightCm, headerCm, footerCm },
  ]),
);

/** Formato da lista, ou `null` para id inexistente, spread ou social. */
export function findSceneFormat(formatId: string): SceneFormatSpec | null {
  return Object.prototype.hasOwnProperty.call(SCENE_FORMATS, formatId)
    ? SCENE_FORMATS[formatId]
    : null;
}

/** Fração máxima da altura para cabeçalho e rodapé (igual ao protótipo). */
const MAX_SECTION_FRACTION = 0.3;

/** Zonas reservadas (cabeçalho, miolo e rodapé) como `Rect` normalizado, como `getZoneRect` do front. */
export function computeSceneZones(format: SceneFormatSpec): SceneZones {
  const total = format.printHeightCm || format.artHeightCm;
  const header = Math.min(MAX_SECTION_FRACTION, format.headerCm / total);
  const footer = Math.min(MAX_SECTION_FRACTION, format.footerCm / total);
  const rect = (y: number, h: number): Rect => ({ x: 0, y, w: 1, h });
  return {
    header: rect(0, header),
    body: rect(header, 1 - header - footer),
    footer: rect(1 - footer, footer),
  };
}
