/**
 * Cor-chave do recorte (change video-mascote-transparente, D3): a cor de fundo
 * com que o tile é achatado antes de ir ao motor de fala e que o compose
 * remove. Só verde e azul (o `despill` do ffmpeg só trata essas duas). A regra
 * mede a fração de pixels OPACOS da identidade perto de cada candidata em
 * CIELAB (ΔE76); sem candidata segura o modo sem fundo é recusado para o kit.
 */

export const MC_CUTOUT_KEY_RULE_VERSION = 1;
export const MC_CUTOUT_KEY_GREEN = '#00B140';
export const MC_CUTOUT_KEY_BLUE = '#0047BB';
/** Ordem de preferência. */
export const MC_CUTOUT_KEY_CANDIDATES = [MC_CUTOUT_KEY_GREEN, MC_CUTOUT_KEY_BLUE] as const;
export type McCutoutKeyColor = (typeof MC_CUTOUT_KEY_CANDIDATES)[number];

/** Limiares da regra (primeiros valores a calibrar na 3.5; mudar exige bump da versão). */
export const MC_CUTOUT_KEY_NEAR_LOW = 40;
export const MC_CUTOUT_KEY_NEAR_HIGH = 60;
export const MC_CUTOUT_KEY_MAX_NEAR_LOW = 0.002;
export const MC_CUTOUT_KEY_MAX_NEAR_HIGH = 0.03;
/** Pixel opaco para a regra. */
const OPAQUE_ALPHA = 128;

export interface McCutoutKeyCandidate {
  color: McCutoutKeyColor;
  near40: number;
  near60: number;
}

export interface McCutoutKeyDecision {
  ruleVersion: number;
  candidates: McCutoutKeyCandidate[];
  chosen: McCutoutKeyColor | null;
  safe: boolean;
}

export type McLab = [number, number, number];

function srgbToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
}

/** sRGB 0..255 → CIELAB (D65). */
export function rgbToLab(r: number, g: number, b: number): McLab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const fy = labF(y);
  return [116 * fy - 16, 500 * (labF(x) - fy), 200 * (fy - labF(z))];
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** ΔE76 entre duas cores Lab. */
export function deltaE76(a: McLab, b: McLab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function candidateIsSafe(c: Pick<McCutoutKeyCandidate, 'near40' | 'near60'>): boolean {
  return c.near40 <= MC_CUTOUT_KEY_MAX_NEAR_LOW && c.near60 <= MC_CUTOUT_KEY_MAX_NEAR_HIGH;
}

/**
 * Escolhe a cor-chave pelos pixels opacos (RGBA cru, já reduzido a ≤ 512 px
 * pelo chamador). Segura = `near40 ≤ 0,002` e `near60 ≤ 0,03`; entre as
 * seguras vence a de menor `near60` (empate: ordem de preferência).
 */
export function chooseCutoutKey(image: { data: Uint8Array; channels: 3 | 4 }): McCutoutKeyDecision {
  const labs = MC_CUTOUT_KEY_CANDIDATES.map((c) => rgbToLab(...hexToRgb(c)));
  const near40 = labs.map(() => 0);
  const near60 = labs.map(() => 0);
  let opaque = 0;
  const { data, channels } = image;
  // cache por cor quantizada em 5 bits por canal: reduz o custo do Lab
  const cache = new Map<number, McLab>();
  for (let i = 0; i + channels <= data.length; i += channels) {
    if (channels === 4 && data[i + 3] < OPAQUE_ALPHA) continue;
    opaque += 1;
    const key = ((data[i] >> 2) << 12) | ((data[i + 1] >> 2) << 6) | (data[i + 2] >> 2);
    let lab = cache.get(key);
    if (!lab) {
      lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      cache.set(key, lab);
    }
    labs.forEach((candidate, idx) => {
      const d = deltaE76(lab, candidate);
      if (d <= MC_CUTOUT_KEY_NEAR_LOW) near40[idx] += 1;
      if (d <= MC_CUTOUT_KEY_NEAR_HIGH) near60[idx] += 1;
    });
  }
  const candidates: McCutoutKeyCandidate[] = MC_CUTOUT_KEY_CANDIDATES.map((color, idx) => ({
    color,
    near40: opaque ? near40[idx] / opaque : 0,
    near60: opaque ? near60[idx] / opaque : 0,
  }));
  const safe = candidates.filter(candidateIsSafe);
  const best = safe.reduce<McCutoutKeyCandidate | null>(
    (acc, c) => (!acc || c.near60 < acc.near60 ? c : acc),
    null,
  );
  return {
    ruleVersion: MC_CUTOUT_KEY_RULE_VERSION,
    candidates,
    chosen: best ? best.color : null,
    safe: !!best,
  };
}
