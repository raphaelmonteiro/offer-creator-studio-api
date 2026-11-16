import type {
  FlyerProFaceKey,
  FlyerProFold,
  FlyerProFormat,
  FlyerProLayout,
} from './flyer-pro.types';

/**
 * Formatos que o Encarte Pro aceita e as faces de cada layout. Tabela própria do módulo: não importa o domínio de
 * `template-scenes` (A-01-16), então os ids dos formatos e as chaves das faces são repetidos aqui de propósito.
 */
export interface FlyerProFormatSpec {
  format: FlyerProFormat;
  fold: FlyerProFold;
  /** Número de páginas que o Setup oferece. */
  pageOptions: readonly number[];
  defaultPageCount: number;
  /** Layouts que o formato aceita; o resto é `LAYOUT_UNSUPPORTED`. */
  layouts: readonly FlyerProLayout[];
}

const FORMATS: Readonly<Record<string, FlyerProFormatSpec>> = {
  'folheto-27x40': {
    format: '27x40',
    fold: 'simple',
    pageOptions: [1, 2, 3, 4],
    defaultPageCount: 1,
    layouts: ['single', 'front_back'],
  },
  'folheto-54x40': {
    format: '54x40',
    fold: 'double',
    pageOptions: [2, 4],
    defaultPageCount: 2,
    layouts: ['tabloid'],
  },
};

/** Ids de formato de cena que entram na lista, na ordem da tabela. */
export const FLYER_PRO_FORMAT_IDS: readonly string[] = Object.keys(FORMATS);

/** O formato do Encarte Pro de um `formatId` de cena; `null` para os formatos fora (20×27, revista, social...). */
export function findFlyerProFormat(formatId: string): FlyerProFormatSpec | null {
  return Object.prototype.hasOwnProperty.call(FORMATS, formatId) ? FORMATS[formatId] : null;
}

/** O `formatId` da cena de um formato do Encarte Pro (`27x40` dá `folheto-27x40`). */
export const sceneFormatIdOf = (format: FlyerProFormat): string => `folheto-${format}`;

/** As faces de cada layout, na ordem do índice da folha. */
const LAYOUT_FACES: Readonly<Record<FlyerProLayout, readonly FlyerProFaceKey[]>> = {
  single: ['single'],
  front_back: ['front', 'back'],
  tabloid: ['outer', 'inner'],
};

/** As chaves das faces do layout, em ordem; layout desconhecido não tem face. */
export function faceKeysOfLayout(layout: string): readonly FlyerProFaceKey[] {
  return Object.prototype.hasOwnProperty.call(LAYOUT_FACES, layout)
    ? LAYOUT_FACES[layout as FlyerProLayout]
    : [];
}
