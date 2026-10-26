import { deltaE76, hexToRgb, McCutoutKeyColor, McLab, rgbToLab } from './mc-cutout-key';
import { cutoutDespillType } from './mc-cutout-graph';
import { dilate, erode } from './mc-cutout-morphology';
import { MC_CUTOUT_REASONS, McCutoutReason } from './mc-cutout-issue';

/**
 * Verificação de qualidade do recorte (change video-mascote-transparente, D7): medidas sobre
 * quadros do clipe e o alfa gerado pela MESMA cadeia do compose (D5). Funções puras sobre buffers
 * RGB/alfa; o `McCutoutQualityService` extrai os quadros com o ffmpeg e chama estas funções.
 * Limites são os primeiros valores (a calibrar no cenário real, 3.5).
 */

export const MC_CUTOUT_FRAMES_PER_CLIP = 8;
export const MC_CUTOUT_MATTE_COVERAGE_MIN = 0.04;
export const MC_CUTOUT_MATTE_COVERAGE_MAX = 0.92;
export const MC_CUTOUT_BACKGROUND_OFFSET_MAX_DE = 15;
export const MC_CUTOUT_BACKGROUND_SPREAD_MAX_DE = 6;
export const MC_CUTOUT_BACKGROUND_DRIFT_MAX_DE = 5;
export const MC_CUTOUT_KEY_RESIDUE_MAX = 0.0005;
export const MC_CUTOUT_FRINGE_EXCESS_MAX = 0.04;
/** Distância mínima (px) do fundo à silhueta para entrar na média do fundo. */
const BACKGROUND_GUARD_PX = 6;
const ALPHA_OPAQUE = 128;
const ALPHA_BACKGROUND = 10;
/** Pixel do resto da chave: cor original a ΔE ≤ 25 da média do fundo. */
const RESIDUE_DE = 25;

export interface McCutoutFrame {
  /** RGB8 (3 canais) do quadro original do clipe. */
  rgb: Uint8Array;
  /**
   * RGB8 do mesmo quadro depois do `despill` (o que entra no composto): o halo é medido aqui —
   * no original a mistura com a chave na borda é inerente ao anti-aliasing do motor.
   * Ausente = usa `rgb`.
   */
  despilled?: Uint8Array;
  /** Alfa 8 bits do mesmo quadro depois da cadeia de recorte (D5). */
  alpha: Uint8Array;
  width: number;
  height: number;
}

export interface McCutoutFrameMetrics {
  matteCoverage: number;
  /** Média Lab do fundo (alfa < 10 e a ≥ 6 px da silhueta); null sem pixel de fundo. */
  backgroundMean: McLab | null;
  backgroundOffsetDeltaE: number;
  /** Desvio-padrão do ΔE76 dos pixels de fundo à média do quadro. */
  backgroundSpread: number;
  keyResidue: number;
  fringeExcess: number;
}

export interface McCutoutClipMetrics {
  matteCoverage: number;
  backgroundOffsetDeltaE: number;
  backgroundSpread: number;
  backgroundDrift: number;
  keyResidue: number;
  fringeExcess: number;
}

export interface McCutoutClipVerdict {
  passed: boolean;
  reasons: McCutoutReason[];
  metrics: McCutoutClipMetrics;
}

/**
 * Excesso POSITIVO da cor de recorte num pixel: (G − max(R,B))/255 na chave verde; (B − max(R,G))/255
 * na azul; negativo vira 0. Sem o corte, o contorno escuro de uma personagem (menos "azul" que o
 * miolo avermelhado ou claro) apareceria como halo mesmo sem nenhum reflexo da chave.
 */
function keyExcess(r: number, g: number, b: number, type: 'green' | 'blue'): number {
  const value = type === 'green' ? (g - Math.max(r, b)) / 255 : (b - Math.max(r, g)) / 255;
  return Math.max(0, value);
}

function labAt(rgb: Uint8Array, index: number, cache: Map<number, McLab>): McLab {
  const r = rgb[index * 3];
  const g = rgb[index * 3 + 1];
  const b = rgb[index * 3 + 2];
  const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
  let lab = cache.get(key);
  if (!lab) {
    lab = rgbToLab(r, g, b);
    cache.set(key, lab);
  }
  return lab;
}

interface BackgroundStats {
  mean: McLab;
  spread: number;
}

/** Silhueta binária (alfa opaco) e o número de pixels opacos. */
function silhouetteOf(alpha: Uint8Array): { silhouette: Uint8Array; opaque: number } {
  const silhouette = new Uint8Array(alpha.length);
  let opaque = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] >= ALPHA_OPAQUE) {
      silhouette[i] = 1;
      opaque += 1;
    }
  }
  return { silhouette, opaque };
}

/** Média e dispersão (desvio-padrão do ΔE76) do fundo; null sem pixel de fundo. */
function backgroundStats(labs: McLab[]): BackgroundStats | null {
  if (labs.length === 0) return null;
  const sum: McLab = [0, 0, 0];
  for (const lab of labs) {
    sum[0] += lab[0];
    sum[1] += lab[1];
    sum[2] += lab[2];
  }
  const mean: McLab = [sum[0] / labs.length, sum[1] / labs.length, sum[2] / labs.length];
  let variance = 0;
  for (const lab of labs) variance += deltaE76(lab, mean) ** 2;
  return { mean, spread: Math.sqrt(variance / labs.length) };
}

/** Pixels de fundo: alfa < 10 e fora da guarda (dilatação da silhueta). */
function backgroundLabs(
  frame: McCutoutFrame,
  silhouette: Uint8Array,
  cache: Map<number, McLab>,
): McLab[] {
  const guard = dilate(silhouette, frame.width, frame.height, BACKGROUND_GUARD_PX);
  const labs: McLab[] = [];
  for (let i = 0; i < frame.alpha.length; i++) {
    if (frame.alpha[i] < ALPHA_BACKGROUND && !guard[i]) labs.push(labAt(frame.rgb, i, cache));
  }
  return labs;
}

/** Pixels da silhueta que ainda têm a cor média do fundo (resto da chave), em fração do quadro. */
function keyResidueOf(
  frame: McCutoutFrame,
  silhouette: Uint8Array,
  mean: McLab,
  cache: Map<number, McLab>,
): number {
  let residue = 0;
  for (let i = 0; i < silhouette.length; i++) {
    if (silhouette[i] && deltaE76(labAt(frame.rgb, i, cache), mean) <= RESIDUE_DE) residue += 1;
  }
  return residue / silhouette.length;
}

/** Métricas de um quadro (D7): cobertura, fundo, resto da chave e halo. */
export function measureCutoutFrame(
  frame: McCutoutFrame,
  keyColor: McCutoutKeyColor,
): McCutoutFrameMetrics {
  const { silhouette, opaque } = silhouetteOf(frame.alpha);
  const matteCoverage = opaque / silhouette.length;
  const cache = new Map<number, McLab>();
  const stats = opaque === 0 ? null : backgroundStats(backgroundLabs(frame, silhouette, cache));
  if (!stats) {
    return {
      matteCoverage,
      backgroundMean: null,
      backgroundOffsetDeltaE: 0,
      backgroundSpread: 0,
      keyResidue: 0,
      fringeExcess: 0,
    };
  }
  return {
    matteCoverage,
    backgroundMean: stats.mean,
    backgroundOffsetDeltaE: deltaE76(stats.mean, rgbToLab(...hexToRgb(keyColor))),
    backgroundSpread: stats.spread,
    keyResidue: keyResidueOf(frame, silhouette, stats.mean, cache),
    fringeExcess: fringeExcess({
      rgb: frame.despilled ?? frame.rgb,
      silhouette,
      width: frame.width,
      height: frame.height,
      type: cutoutDespillType(keyColor),
    }),
  };
}

interface FringeInput {
  rgb: Uint8Array;
  silhouette: Uint8Array;
  width: number;
  height: number;
  type: 'green' | 'blue';
}

/** Anel de largura R dentro da silhueta menos a região interna (silhueta erodida em 3R). */
function fringeExcess({ rgb, silhouette, width, height, type }: FringeInput): number {
  const ringWidth = Math.max(2, Math.round(0.006 * Math.max(width, height)));
  const inner = erode(silhouette, width, height, ringWidth);
  const core = erode(silhouette, width, height, ringWidth * 3);
  let ring = 0;
  let ringN = 0;
  let inside = 0;
  let insideN = 0;
  for (let i = 0; i < silhouette.length; i++) {
    const value = keyExcess(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], type);
    if (silhouette[i] && !inner[i]) {
      ring += value;
      ringN += 1;
    } else if (core[i]) {
      inside += value;
      insideN += 1;
    }
  }
  if (ringN === 0 || insideN === 0) return 0;
  return ring / ringN - inside / insideN;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Motivos de reprovação de um quadro, pelas métricas dele. */
function frameReasons(m: McCutoutFrameMetrics): McCutoutReason[] {
  const reasons: McCutoutReason[] = [];
  if (m.matteCoverage < MC_CUTOUT_MATTE_COVERAGE_MIN) reasons.push('matte_empty');
  if (m.matteCoverage > MC_CUTOUT_MATTE_COVERAGE_MAX) reasons.push('matte_full');
  if (m.backgroundMean === null) return reasons;
  if (m.backgroundOffsetDeltaE > MC_CUTOUT_BACKGROUND_OFFSET_MAX_DE) {
    reasons.push('background_not_key');
  }
  if (m.backgroundSpread > MC_CUTOUT_BACKGROUND_SPREAD_MAX_DE) reasons.push('background_unstable');
  if (m.keyResidue > MC_CUTOUT_KEY_RESIDUE_MAX) reasons.push('key_residue');
  if (m.fringeExcess > MC_CUTOUT_FRINGE_EXCESS_MAX) reasons.push('edge_fringe');
  return reasons;
}

/** Deriva do fundo: ΔE máximo entre a média de fundo de cada quadro e a mediana dos quadros. */
function backgroundDriftOf(frames: McCutoutFrameMetrics[]): number {
  const means = frames.map((m) => m.backgroundMean).filter((m): m is McLab => m !== null);
  if (means.length < 2) return 0;
  const mid: McLab = [
    median(means.map((m) => m[0])),
    median(means.map((m) => m[1])),
    median(means.map((m) => m[2])),
  ];
  return Math.max(...means.map((m) => deltaE76(m, mid)));
}

/** Métricas do clipe: média da cobertura e pior valor das demais entre os quadros. */
function clipMetricsOf(frames: McCutoutFrameMetrics[], drift: number): McCutoutClipMetrics {
  const max = (pick: (m: McCutoutFrameMetrics) => number) =>
    frames.length ? Math.max(...frames.map(pick)) : 0;
  return {
    matteCoverage: frames.length
      ? frames.reduce((s, m) => s + m.matteCoverage, 0) / frames.length
      : 0,
    backgroundOffsetDeltaE: max((m) => m.backgroundOffsetDeltaE),
    backgroundSpread: max((m) => m.backgroundSpread),
    backgroundDrift: drift,
    keyResidue: max((m) => m.keyResidue),
    fringeExcess: max((m) => m.fringeExcess),
  };
}

/**
 * Veredito de um clipe a partir das métricas dos quadros: qualquer quadro fora do limite reprova;
 * a deriva é o ΔE máximo entre a média de fundo de cada quadro e a mediana dos quadros.
 */
export function evaluateCutoutClip(frames: McCutoutFrameMetrics[]): McCutoutClipVerdict {
  const reasons = new Set<McCutoutReason>(frames.flatMap(frameReasons));
  const drift = backgroundDriftOf(frames);
  if (drift > MC_CUTOUT_BACKGROUND_DRIFT_MAX_DE) reasons.add('background_unstable');
  const ordered = MC_CUTOUT_REASONS.filter((r) => reasons.has(r));
  return { passed: ordered.length === 0, reasons: ordered, metrics: clipMetricsOf(frames, drift) };
}

/** Índices (base 0) dos quadros medidos: instantes `(i + 0,5) / 8 × duração` a 30 fps. */
export function cutoutSampleFrameIndexes(durationS: number, fps = 30): number[] {
  const total = Math.max(1, Math.floor(durationS * fps));
  const indexes = Array.from({ length: MC_CUTOUT_FRAMES_PER_CLIP }, (_, i) =>
    Math.min(total - 1, Math.floor(((i + 0.5) / MC_CUTOUT_FRAMES_PER_CLIP) * total)),
  );
  return Array.from(new Set(indexes));
}
