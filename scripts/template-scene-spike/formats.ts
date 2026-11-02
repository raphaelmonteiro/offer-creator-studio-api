/**
 * Formatos de impressão usados pelo spike. Dimensões da arte com sangria (cm) copiadas de
 * `frontend/src/types/editor.ts` e alturas de cabeçalho/rodapé (cm) de `FORMAT_SECTION_HEIGHTS`
 * em `frontend/src/pages/AiTemplateGenerator.tsx:49-67` (o script não importa o frontend).
 */

export interface FormatSpec {
  id: string;
  artWidthCm: number;
  artHeightCm: number;
  headerCm: number;
  footerCm: number;
}

const rows: Array<[string, number, number, number, number]> = [
  ['revista-20x26.5', 20.5, 27, 6, 4],
  ['revista-13x19.5', 14, 20.5, 4, 3],
  ['folheto-55x36', 55, 36.5, 6, 4],
  ['folheto-54x40', 55, 41, 6, 4],
  ['folheto-54x30', 55, 30.5, 5, 3],
  ['folheto-27x54', 27.5, 55, 6, 4],
  ['folheto-27x40', 27.5, 41, 6, 4],
  ['folheto-27x30', 27.5, 30.5, 5, 3],
  ['folheto-20x27', 20.5, 27.5, 6, 4],
  ['folheto-10x13', 10.5, 13.75, 3, 2],
];

export const FORMATS: Record<string, FormatSpec> = Object.fromEntries(
  rows.map(([id, artWidthCm, artHeightCm, headerCm, footerCm]) => [
    id,
    { id, artWidthCm, artHeightCm, headerCm, footerCm },
  ]),
);

export interface NativeSize {
  width: number;
  height: number;
}

export const MIN_AREA = 655_360;
export const MAX_AREA = 8_294_400;
export const MAX_EDGE = 3840;
/** Limite da spec (1%). */
const RATIO_LIMIT = 0.01;
/** Tolerâncias tentadas em ordem; 0,25% reproduz a tabela de tamanhos do design (PV-9). */
const RATIO_STEPS = [0.0025, RATIO_LIMIT];

function largestWithin(ratio: number, tolerance: number): NativeSize | null {
  let best: (NativeSize & { area: number }) | null = null;
  for (let w = 16; w <= MAX_EDGE; w += 16) {
    for (let h = 16; h <= MAX_EDGE; h += 16) {
      const area = w * h;
      if (area < MIN_AREA || area > MAX_AREA) continue;
      if (Math.abs(w / h - ratio) / ratio > tolerance) continue;
      if (!best || area > best.area) best = { width: w, height: h, area };
    }
  }
  return best ? { width: best.width, height: best.height } : null;
}

/**
 * Maior `w x h` com lados múltiplos de 16, proporção a até 1% da arte (tentando 0,25% antes), borda até 3840 e área entre
 * 655.360 e 8.294.400 px. Recusa formato fora de 1:3 a 3:1.
 */
export function nativeSize(artWidthCm: number, artHeightCm: number): NativeSize {
  const ratio = artWidthCm / artHeightCm;
  if (ratio < 1 / 3 || ratio > 3) {
    throw new Error(
      `Proporção ${ratio.toFixed(3)} fora do limite do modelo (1:3 a 3:1): ${artWidthCm}x${artHeightCm} cm`,
    );
  }
  let best: NativeSize | null = null;
  for (const tolerance of RATIO_STEPS) {
    best = largestWithin(ratio, tolerance);
    if (best) break;
  }
  if (!best) throw new Error(`Nenhum tamanho válido para ${artWidthCm}x${artHeightCm} cm`);
  return best;
}

export function formatOrThrow(formatId: string): FormatSpec {
  const format = FORMATS[formatId];
  if (!format) throw new Error(`Formato desconhecido: ${formatId}`);
  return format;
}
