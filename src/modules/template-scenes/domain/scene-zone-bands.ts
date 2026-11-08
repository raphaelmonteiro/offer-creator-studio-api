import { computeSceneZones, SceneFormatSpec } from './scene-formats';

/** Folga de ponto flutuante: 3328 × (1 − 4/27) não pode virar 2836 por um erro na 12ª casa. */
const EPS = 1e-9;

export interface ZoneBands {
  /** O cabeçalho vai de 0 até este y (exclusive), em px. */
  headerEnd: number;
  /** O rodapé começa neste y (inclusive), em px. */
  footerStart: number;
  headerPct: string;
  footerPct: string;
}

const pct = (fraction: number): string => (fraction * 100).toFixed(1);

/**
 * As faixas de `computeSceneZones` em px sobre a altura nativa da master (D-51). O limite fica dentro da faixa pedida:
 * o cabeçalho arredonda para baixo e o rodapé para cima. Em `folheto-20x27` a `2480x3328`: y < 739 e y ≥ 2835.
 * Quem escreve as medidas é o código, nunca o Diretor.
 */
export function zoneBands(format: SceneFormatSpec, heightPx: number): ZoneBands {
  const zones = computeSceneZones(format);
  return {
    headerEnd: Math.floor(heightPx * zones.header.h + EPS),
    footerStart: Math.ceil(heightPx * zones.footer.y - EPS),
    headerPct: pct(zones.header.h),
    footerPct: pct(zones.footer.h),
  };
}
