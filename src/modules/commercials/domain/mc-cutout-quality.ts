import { deltaE76, hexToRgb, McCutoutKeyColor, McLab, rgbToLab } from './mc-cutout-key';
import { cutoutDespillType } from './mc-cutout-graph';

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

export const MC_CUTOUT_REASONS = [
  'matte_empty',
  'matte_full',
  'background_not_key',
  'background_unstable',
  'key_residue',
  'edge_fringe',
] as const;
export type McCutoutReason = (typeof MC_CUTOUT_REASONS)[number];

/** Textos pt-BR de cada motivo (uma tabela, no código). */
export const MC_CUTOUT_REASON_MESSAGES: Record<McCutoutReason, string> = {
  matte_empty: 'A personagem não foi encontrada no quadro.',
  matte_full: 'O recorte pegou o quadro quase inteiro.',
  background_not_key: 'O fundo da fala saiu de outra cor que não a de recorte.',
  background_unstable: 'O fundo mudou de tom durante a fala.',
  key_residue: 'Sobrou a cor do fundo dentro da personagem.',
  edge_fringe: 'Ficou um halo da cor do fundo na borda da personagem.',
};

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

/** Máscara binária dilatada em `radius` px (janela quadrada, separável). */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = 0;
      for (let k = Math.max(0, x - radius); k <= Math.min(width - 1, x + radius); k++) {
        if (mask[y * width + k]) {
          hit = 1;
          break;
        }
      }
      horizontal[y * width + x] = hit;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let hit = 0;
      for (let k = Math.max(0, y - radius); k <= Math.min(height - 1, y + radius); k++) {
        if (horizontal[k * width + x]) {
          hit = 1;
          break;
        }
      }
      out[y * width + x] = hit;
    }
  }
  return out;
}

/** Erosão = complemento da dilatação do complemento. */
function erode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const inverse = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inverse[i] = mask[i] ? 0 : 1;
  const grown = dilate(inverse, width, height, radius);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = grown[i] ? 0 : 1;
  return out;
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

/** Métricas de um quadro (D7): cobertura, fundo, resto da chave e halo. */
export function measureCutoutFrame(
  frame: McCutoutFrame,
  keyColor: McCutoutKeyColor,
): McCutoutFrameMetrics {
  const { rgb, alpha, width, height } = frame;
  const total = width * height;
  const silhouette = new Uint8Array(total);
  let opaque = 0;
  for (let i = 0; i < total; i++) {
    if (alpha[i] >= ALPHA_OPAQUE) {
      silhouette[i] = 1;
      opaque += 1;
    }
  }
  const keyLab = rgbToLab(...hexToRgb(keyColor));
  const cache = new Map<number, McLab>();
  const guard = dilate(silhouette, width, height, BACKGROUND_GUARD_PX);
  const bgLabs: McLab[] = [];
  const sum: McLab = [0, 0, 0];
  for (let i = 0; i < total; i++) {
    if (alpha[i] >= ALPHA_BACKGROUND || guard[i]) continue;
    const lab = labAt(rgb, i, cache);
    bgLabs.push(lab);
    sum[0] += lab[0];
    sum[1] += lab[1];
    sum[2] += lab[2];
  }
  const empty = {
    matteCoverage: opaque / total,
    backgroundMean: null,
    backgroundOffsetDeltaE: 0,
    backgroundSpread: 0,
    keyResidue: 0,
    fringeExcess: 0,
  };
  if (bgLabs.length === 0 || opaque === 0) return empty;
  const mean: McLab = [sum[0] / bgLabs.length, sum[1] / bgLabs.length, sum[2] / bgLabs.length];
  let variance = 0;
  for (const lab of bgLabs) variance += deltaE76(lab, mean) ** 2;
  const spread = Math.sqrt(variance / bgLabs.length);
  let residue = 0;
  for (let i = 0; i < total; i++) {
    if (silhouette[i] && deltaE76(labAt(rgb, i, cache), mean) <= RESIDUE_DE) residue += 1;
  }
  return {
    matteCoverage: opaque / total,
    backgroundMean: mean,
    backgroundOffsetDeltaE: deltaE76(mean, keyLab),
    backgroundSpread: spread,
    keyResidue: residue / total,
    fringeExcess: fringeExcess(
      frame.despilled ?? rgb,
      silhouette,
      width,
      height,
      cutoutDespillType(keyColor),
    ),
  };
}

/** Anel de largura R dentro da silhueta menos a região interna (silhueta erodida em 3R). */
function fringeExcess(
  rgb: Uint8Array,
  silhouette: Uint8Array,
  width: number,
  height: number,
  type: 'green' | 'blue',
): number {
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

/**
 * Veredito de um clipe a partir das métricas dos quadros: qualquer quadro fora do limite reprova;
 * a deriva é o ΔE máximo entre a média de fundo de cada quadro e a mediana dos quadros.
 */
export function evaluateCutoutClip(frames: McCutoutFrameMetrics[]): McCutoutClipVerdict {
  const reasons = new Set<McCutoutReason>();
  for (const m of frames) {
    if (m.matteCoverage < MC_CUTOUT_MATTE_COVERAGE_MIN) reasons.add('matte_empty');
    if (m.matteCoverage > MC_CUTOUT_MATTE_COVERAGE_MAX) reasons.add('matte_full');
    if (m.backgroundMean === null) continue;
    if (m.backgroundOffsetDeltaE > MC_CUTOUT_BACKGROUND_OFFSET_MAX_DE) {
      reasons.add('background_not_key');
    }
    if (m.backgroundSpread > MC_CUTOUT_BACKGROUND_SPREAD_MAX_DE) reasons.add('background_unstable');
    if (m.keyResidue > MC_CUTOUT_KEY_RESIDUE_MAX) reasons.add('key_residue');
    if (m.fringeExcess > MC_CUTOUT_FRINGE_EXCESS_MAX) reasons.add('edge_fringe');
  }
  const means = frames.map((m) => m.backgroundMean).filter((m): m is McLab => m !== null);
  let drift = 0;
  if (means.length > 1) {
    const mid: McLab = [
      median(means.map((m) => m[0])),
      median(means.map((m) => m[1])),
      median(means.map((m) => m[2])),
    ];
    drift = Math.max(...means.map((m) => deltaE76(m, mid)));
    if (drift > MC_CUTOUT_BACKGROUND_DRIFT_MAX_DE) reasons.add('background_unstable');
  }
  const max = (pick: (m: McCutoutFrameMetrics) => number) =>
    frames.length ? Math.max(...frames.map(pick)) : 0;
  const metrics: McCutoutClipMetrics = {
    matteCoverage: frames.length
      ? frames.reduce((s, m) => s + m.matteCoverage, 0) / frames.length
      : 0,
    backgroundOffsetDeltaE: max((m) => m.backgroundOffsetDeltaE),
    backgroundSpread: max((m) => m.backgroundSpread),
    backgroundDrift: drift,
    keyResidue: max((m) => m.keyResidue),
    fringeExcess: max((m) => m.fringeExcess),
  };
  const ordered = MC_CUTOUT_REASONS.filter((r) => reasons.has(r));
  return { passed: ordered.length === 0, reasons: ordered, metrics };
}

/** Índices (base 0) dos quadros medidos: instantes `(i + 0,5) / 8 × duração` a 30 fps. */
export function cutoutSampleFrameIndexes(durationS: number, fps = 30): number[] {
  const total = Math.max(1, Math.floor(durationS * fps));
  const indexes = Array.from({ length: MC_CUTOUT_FRAMES_PER_CLIP }, (_, i) =>
    Math.min(total - 1, Math.floor(((i + 0.5) / MC_CUTOUT_FRAMES_PER_CLIP) * total)),
  );
  return Array.from(new Set(indexes));
}

export const CHARACTER_CUTOUT_FAILED = 'character_cutout_failed';

/** Mensagem padrão do projeto em `needs_attention` (pt-BR). */
export function cutoutFailureMessage(failedScenes: number): string {
  return (
    `O recorte da personagem ficou com falhas em ${failedScenes} fala(s) (fundo instável, ` +
    'resto da cor de fundo ou halo na borda). Gere a fala de novo ou use um painel liso.'
  );
}

/** Cena reprovada como o `cutoutIssue` do projeto expõe (motivos com texto em pt-BR). */
export interface McCutoutIssueScene {
  sceneId: string;
  idx: number;
  reasons: Array<{ code: McCutoutReason; message: string }>;
  metrics: Partial<McCutoutClipMetrics>;
}

export interface McCutoutIssue {
  code: typeof CHARACTER_CUTOUT_FAILED;
  message: string;
  keyColor: string | null;
  scenes: McCutoutIssueScene[];
  /** Espelho de `availableActions`. */
  actions: string[];
}

/** `cutoutIssue` de `GET projects/:id` a partir do detalhe do evento `cutout_rejected` (D7). */
export function buildCutoutIssue(
  detail: Record<string, unknown> | null | undefined,
  actions: string[],
): McCutoutIssue {
  const rawScenes = Array.isArray(detail?.scenes)
    ? (detail?.scenes as Array<Record<string, unknown>>)
    : [];
  const scenes: McCutoutIssueScene[] = rawScenes.map((s) => ({
    sceneId: String(s.sceneId),
    idx: Number(s.idx),
    reasons: (Array.isArray(s.reasons) ? (s.reasons as McCutoutReason[]) : [])
      .filter((code) => code in MC_CUTOUT_REASON_MESSAGES)
      .map((code) => ({ code, message: MC_CUTOUT_REASON_MESSAGES[code] })),
    metrics: (s.metrics ?? {}) as Partial<McCutoutClipMetrics>,
  }));
  return {
    code: CHARACTER_CUTOUT_FAILED,
    message: cutoutFailureMessage(scenes.length),
    keyColor: typeof detail?.keyColor === 'string' ? detail.keyColor : null,
    scenes,
    actions,
  };
}
