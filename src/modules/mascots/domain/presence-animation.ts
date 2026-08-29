/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ MÓDULO ESPELHADO — mantenha idêntico em:                                │
 * │   backend/src/modules/mascots/domain/presence-animation.ts              │
 * │   frontend/src/utils/mascot/presenceAnimation.ts                        │
 * │ Qualquer divergência quebra a garantia "preview == export" (spike §3.3).│
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Animação de PRESENÇA do mascote (Abordagem D, spike §2/§3.6) — sem IA, sem
 * rig, sem lip-sync. São transformações geométricas sobre os pixels originais:
 * respiração, entrada lateral e 5 presets de gesto.
 *
 * Restrição da v1 (spike §3.3): **interpolação linear pura**. Nada de easing,
 * nada de transformações aninhadas. A timeline sai daqui já "assada" — as
 * contribuições (respiração × gesto × entrada) são combinadas em tempo de
 * construção, em pontos de quebra determinísticos, e cada propriedade vira UMA
 * trilha linear. Assim os dois renderers (browser e worker) só precisam
 * concordar em `sampleTrack`, que é interpolação linear trivial.
 *
 * NÃO existe função aqui que redesenhe o mascote. Só translate/scale/rotate/
 * opacity — a identidade é preservada por construção.
 */

/** Parâmetros de craft (spike §3.6) — constantes, não deixados ao acaso. */
export const MASCOT_CRAFT = {
  /** Frame rate alvo do renderer 2D. */
  fps: 24,
  /** Respiração: escala do tronco ±1,5%. */
  breathAmplitude: 0.015,
  /** Respiração: ciclo de 3,5 s. */
  breathCycleMs: 3500,
  /** Entrada deslizando pela lateral. */
  entranceMs: 700,
  /**
   * Fade da entrada — só o começo do deslize. Constante própria (e não
   * `entranceMs / 3`) para que o ponto de quebra caia num inteiro exato: os
   * dois renderers precisam concordar no valor, não "quase".
   */
  entranceFadeMs: 250,
  /** Fração da largura de onde o mascote entra (fora do próprio quadro). */
  entranceOffset: 1.2,
  /** Squash/stretch máximo em gestos — acima disso deforma a marca. */
  maxSquashStretch: 0.06,
  /** Rotação máxima de gesto, em graus (mascote inteiro, sem rig). */
  maxGestureRotationDeg: 6,
  /** Piscar (Fase 3 — exige rig com camada de olhos; não gera trilha aqui). */
  blinkIntervalMs: [2800, 5200] as const,
  blinkDurationMs: 120,
  /** Sincronia áudio/boca tolerada no arquivo final (Fase 3). */
  audioSyncToleranceMs: 50,
  /** Duração mínima de um visema (Fase 3). */
  minVisemeMs: 80,
} as const;

/** Os 5 presets de gesto da v1 (congelados — spike risco 9). */
export const MASCOT_GESTURES = ['idle_bounce', 'wave', 'point', 'dance', 'enter_side'] as const;
export type MascotGesture = (typeof MASCOT_GESTURES)[number];

export const MASCOT_ENTRANCES = ['none', 'left', 'right'] as const;
export type MascotEntrance = (typeof MASCOT_ENTRANCES)[number];

export type MascotTrackProperty = 'translateX' | 'translateY' | 'scale' | 'rotate' | 'opacity';

export interface MascotKeyframe {
  /** Instante em ms desde o início da timeline. */
  tMs: number;
  /**
   * translateX/translateY: fração do tamanho do próprio mascote (0,05 = 5%).
   * scale: multiplicador (1 = tamanho original). rotate: graus. opacity: 0..1.
   */
  value: number;
}

export interface MascotTrack {
  property: MascotTrackProperty;
  keyframes: MascotKeyframe[];
}

export interface MascotTransform {
  translateX: number;
  translateY: number;
  scale: number;
  rotate: number;
  opacity: number;
}

export interface MascotPresenceTimeline {
  /** Versão do formato — o renderer recusa o que não conhece. */
  version: 1;
  durationMs: number;
  fps: number;
  gesture: MascotGesture;
  entrance: MascotEntrance;
  /** Interpolação da v1. Existe para o renderer poder recusar formatos futuros. */
  interpolation: 'linear';
  tracks: MascotTrack[];
}

export interface BuildPresenceTimelineOptions {
  durationMs: number;
  gesture?: MascotGesture;
  entrance?: MascotEntrance;
  /** Intensidade global do gesto, 0..1 (default 1). */
  intensity?: number;
  fps?: number;
}

export const IDENTITY_TRANSFORM: MascotTransform = {
  translateX: 0,
  translateY: 0,
  scale: 1,
  rotate: 0,
  opacity: 1,
};

const TRACK_PROPERTIES: MascotTrackProperty[] = [
  'translateX',
  'translateY',
  'scale',
  'rotate',
  'opacity',
];

/** Arredonda para 4 casas — evita ruído de ponto flutuante entre renderers. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Onda triangular em [-1, 1], linear por partes (compatível com a v1). */
function triangle(tMs: number, cycleMs: number): number {
  const phase = ((tMs % cycleMs) + cycleMs) % cycleMs;
  const quarter = cycleMs / 4;
  if (phase < quarter) return phase / quarter;
  if (phase < 3 * quarter) return 1 - (phase - quarter) / quarter;
  return -1 + (phase - 3 * quarter) / quarter;
}

/** Respiração: escala uniforme ±breathAmplitude, ciclo breathCycleMs. */
function breathScale(tMs: number): number {
  return 1 + MASCOT_CRAFT.breathAmplitude * triangle(tMs, MASCOT_CRAFT.breathCycleMs);
}

interface GestureSpec {
  /** Ciclo do gesto; 0 = gesto sem repetição (mantido). */
  cycleMs: number;
  evaluate: (tMs: number, intensity: number) => Partial<MascotTransform>;
}

const GESTURE_SPECS: Record<MascotGesture, GestureSpec> = {
  // Bob vertical sutil — a "vida" mínima em cima da respiração.
  idle_bounce: {
    cycleMs: 2000,
    evaluate: (tMs, k) => ({
      translateY: round4(-0.015 * k * (triangle(tMs, 2000) * 0.5 + 0.5)),
    }),
  },
  // Aceno: sem rig, o mascote inteiro balança. Rotação limitada a ±6°.
  wave: {
    cycleMs: 1200,
    evaluate: (tMs, k) => ({
      rotate: round4(MASCOT_CRAFT.maxGestureRotationDeg * k * triangle(tMs, 1200)),
      translateY: round4(-0.01 * k),
    }),
  },
  // Apontar: inclina e desloca em direção à oferta, e SEGURA (sem ciclo).
  point: {
    cycleMs: 0,
    evaluate: (_tMs, k) => ({
      translateX: round4(0.04 * k),
      rotate: round4(4 * k),
    }),
  },
  // Dança: deslocamento lateral com contra-rotação.
  dance: {
    cycleMs: 1200,
    evaluate: (tMs, k) => {
      const w = triangle(tMs, 1200);
      return {
        translateX: round4(0.03 * k * w),
        rotate: round4(-4 * k * w),
        scale: round4(1 + MASCOT_CRAFT.maxSquashStretch * 0.5 * k * Math.abs(w)),
      };
    },
  },
  // Entrada enfatizada: só respiração depois de assentar (a entrada em si é
  // aplicada pela trilha de `entrance`).
  enter_side: {
    cycleMs: 0,
    evaluate: () => ({}),
  },
};

/** Contribuição da entrada lateral: fora do quadro → posição final. */
function entranceContribution(tMs: number, entrance: MascotEntrance): Partial<MascotTransform> {
  if (entrance === 'none') return {};
  const d = MASCOT_CRAFT.entranceMs;
  if (tMs >= d) return {};
  const progress = clamp(tMs / d, 0, 1);
  const sign = entrance === 'left' ? -1 : 1;
  return {
    translateX: round4(sign * MASCOT_CRAFT.entranceOffset * (1 - progress)),
    // fade só no começo — evita mascote "fantasma" atravessando a arte
    opacity: round4(clamp(tMs / MASCOT_CRAFT.entranceFadeMs, 0, 1)),
  };
}

/**
 * Pontos de quebra da timeline: onde alguma contribuição muda de inclinação.
 * Assar a timeline nesses pontos é o que garante que browser e worker
 * produzam exatamente os mesmos valores.
 */
function breakpoints(
  durationMs: number,
  gesture: MascotGesture,
  entrance: MascotEntrance,
): number[] {
  const points = new Set<number>([0, durationMs]);
  const add = (t: number) => {
    if (t > 0 && t < durationMs) points.add(Math.round(t));
  };

  const breathStep = MASCOT_CRAFT.breathCycleMs / 4;
  for (let t = breathStep; t < durationMs; t += breathStep) add(t);

  const cycle = GESTURE_SPECS[gesture].cycleMs;
  if (cycle > 0) {
    const step = cycle / 4;
    for (let t = step; t < durationMs; t += step) add(t);
  }

  if (entrance !== 'none') {
    add(MASCOT_CRAFT.entranceFadeMs);
    add(MASCOT_CRAFT.entranceMs);
  }

  return [...points].sort((a, b) => a - b);
}

/** Avalia o transform composto num instante — respiração × gesto × entrada. */
function evaluateAt(
  tMs: number,
  gesture: MascotGesture,
  entrance: MascotEntrance,
  intensity: number,
): MascotTransform {
  const gestureValues = GESTURE_SPECS[gesture].evaluate(tMs, intensity);
  const entranceValues = entranceContribution(tMs, entrance);
  return {
    translateX: round4((gestureValues.translateX ?? 0) + (entranceValues.translateX ?? 0)),
    translateY: round4((gestureValues.translateY ?? 0) + (entranceValues.translateY ?? 0)),
    scale: round4(breathScale(tMs) * (gestureValues.scale ?? 1)),
    rotate: round4((gestureValues.rotate ?? 0) + (entranceValues.rotate ?? 0)),
    opacity: round4(entranceValues.opacity ?? 1),
  };
}

/**
 * Constrói a timeline de presença. Determinística: mesmas opções ⇒ mesmos
 * keyframes, byte a byte, nos dois renderers.
 */
export function buildPresenceTimeline(
  options: BuildPresenceTimelineOptions,
): MascotPresenceTimeline {
  const durationMs = Math.max(1, Math.round(options.durationMs));
  const gesture = options.gesture ?? 'idle_bounce';
  const entrance = options.entrance ?? 'none';
  const intensity = clamp(options.intensity ?? 1, 0, 1);
  const fps = options.fps ?? MASCOT_CRAFT.fps;

  const times = breakpoints(durationMs, gesture, entrance);
  const samples = times.map((tMs) => ({
    tMs,
    transform: evaluateAt(tMs, gesture, entrance, intensity),
  }));

  const tracks: MascotTrack[] = TRACK_PROPERTIES.map((property) => ({
    property,
    keyframes: samples.map(({ tMs, transform }) => ({ tMs, value: transform[property] })),
  }))
    // trilha que só repete o valor neutro não precisa existir — menos ruído no
    // JSON. Cuidado: constante ≠ neutra (o gesto `point` SEGURA um valor).
    .filter((track) => track.keyframes.some((k) => k.value !== IDENTITY_TRANSFORM[track.property]));

  return { version: 1, durationMs, fps, gesture, entrance, interpolation: 'linear', tracks };
}

/** Interpolação LINEAR pura, com clamp fora dos extremos (spike §3.3). */
export function sampleTrack(track: MascotTrack, tMs: number): number {
  const kf = track.keyframes;
  if (kf.length === 0) return 0;
  if (tMs <= kf[0].tMs) return kf[0].value;
  const last = kf[kf.length - 1];
  if (tMs >= last.tMs) return last.value;
  for (let i = 1; i < kf.length; i += 1) {
    const b = kf[i];
    if (tMs <= b.tMs) {
      const a = kf[i - 1];
      const span = b.tMs - a.tMs;
      if (span <= 0) return b.value;
      return round4(a.value + ((b.value - a.value) * (tMs - a.tMs)) / span);
    }
  }
  return last.value;
}

/**
 * Amostra o transform completo. `tMs` além da duração dá a volta (idle em
 * loop, spike §3.5) — nunca congela no último frame.
 */
export function samplePresence(timeline: MascotPresenceTimeline, tMs: number): MascotTransform {
  const t =
    timeline.durationMs > 0
      ? ((tMs % timeline.durationMs) + timeline.durationMs) % timeline.durationMs
      : 0;
  const transform: MascotTransform = { ...IDENTITY_TRANSFORM };
  for (const track of timeline.tracks) {
    transform[track.property] = sampleTrack(track, t);
  }
  return transform;
}

/** `transform` CSS equivalente — usado pelo preview no browser. */
export function toCssTransform(transform: MascotTransform): string {
  const parts = [
    `translate(${round4(transform.translateX * 100)}%, ${round4(transform.translateY * 100)}%)`,
    `scale(${transform.scale})`,
  ];
  if (transform.rotate !== 0) parts.push(`rotate(${transform.rotate}deg)`);
  return parts.join(' ');
}

export function isMascotGesture(value: unknown): value is MascotGesture {
  return typeof value === 'string' && (MASCOT_GESTURES as readonly string[]).includes(value);
}

export function isMascotEntrance(value: unknown): value is MascotEntrance {
  return typeof value === 'string' && (MASCOT_ENTRANCES as readonly string[]).includes(value);
}
