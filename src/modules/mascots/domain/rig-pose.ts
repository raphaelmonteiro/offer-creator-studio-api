/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ MÓDULO ESPELHADO — mantenha idêntico em:                                │
 * │   backend/src/modules/mascots/domain/rig-pose.ts                        │
 * │   frontend/src/utils/mascot/rigPose.ts                                  │
 * │ Divergência aqui = preview e vídeo exportado mostrando coisas diferentes│
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Motor de POSE do rig: transforma (gesto, instante) em ângulos por peça.
 *
 * É aqui que o mascote ganha vida de verdade. Diferente da animação de presença
 * (que inclina a foto inteira), aqui **cada peça gira na sua própria
 * articulação**: o braço no ombro, a cabeça no pescoço, a perna no quadril.
 *
 * Restrição da v1 (spike §3.3): interpolação linear pura, sem easing e sem
 * cadeias aninhadas. Cada gesto é uma função determinística do tempo.
 */

import { MascotRig, MascotRigLayer, MascotRigRole } from './rig.types';

/** Gestos da v1 — congelados (spike risco 9). */
export const RIG_GESTURES = ['idle', 'wave', 'dance', 'point', 'jump', 'talk'] as const;
export type RigGesture = (typeof RIG_GESTURES)[number];

export const RIG_GESTURE_LABELS_PT: Record<RigGesture, string> = {
  idle: 'Parado (respirando)',
  wave: 'Dando tchau',
  dance: 'Dançando',
  point: 'Apontando',
  jump: 'Pulando',
  talk: 'Falando',
};

/** Limites de craft — o mascote se mexe, mas não vira caricatura de si mesmo. */
export const POSE_LIMITS = {
  /** Rotação máxima de um braço, em graus. */
  maxArmDeg: 75,
  /** Rotação máxima da cabeça. */
  maxHeadDeg: 14,
  /** Rotação máxima do tronco. */
  maxTorsoDeg: 6,
  /** Rotação máxima de uma perna. */
  maxLegDeg: 18,
  /** Squash/stretch máximo (spike §3.6). */
  maxSquash: 0.06,
  /** Deslocamento vertical máximo do corpo, em frações da altura. */
  maxHopY: 0.08,
  fps: 24,
} as const;

export interface MascotPose {
  /** Graus de rotação por peça. Ausente = 0. */
  rotate: Partial<Record<MascotRigRole, number>>;
  /** Deslocamento do corpo inteiro, em frações do canvas. */
  offsetX: number;
  offsetY: number;
  /** Escala global (respiração / squash). */
  scale: number;
  /** 0 = boca fechada, 1 = aberta no máximo. Usado a partir da fatia 3. */
  mouthOpen: number;
}

export const REST_POSE: MascotPose = {
  rotate: {},
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  mouthOpen: 0,
};

const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v);
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Onda triangular em [-1,1] — linear por partes, compatível com a v1. */
function tri(tMs: number, cycleMs: number): number {
  const phase = ((tMs % cycleMs) + cycleMs) % cycleMs;
  const q = cycleMs / 4;
  if (phase < q) return phase / q;
  if (phase < 3 * q) return 1 - (phase - q) / q;
  return -1 + (phase - 3 * q) / q;
}

/** Onda em [0,1] — começa no meio do caminho. */
const tri01 = (tMs: number, cycleMs: number) => tri(tMs, cycleMs) * 0.5 + 0.5;

/**
 * Onda em [0,1] que **começa e termina em 0**, com pico no meio do ciclo.
 * É o que o pulo precisa: o mascote sai do chão, sobe e volta — em vez de
 * aparecer já no ar no instante zero.
 */
function hop01(tMs: number, cycleMs: number): number {
  const phase = ((tMs % cycleMs) + cycleMs) % cycleMs;
  return 1 - Math.abs((2 * phase) / cycleMs - 1);
}

/** Respiração comum a todos os gestos (spike §3.6: ±1,5% em 3,5 s). */
function breath(tMs: number): number {
  return 1 + 0.015 * tri(tMs, 3500);
}

/**
 * Pose do mascote num instante. Determinística: mesmos argumentos ⇒ mesma pose,
 * no browser e no worker.
 */
export function samplePose(gesture: RigGesture, tMs: number, intensity = 1): MascotPose {
  const k = clamp(intensity, 0, 1);
  const pose: MascotPose = { ...REST_POSE, rotate: {}, scale: breath(tMs) };

  switch (gesture) {
    case 'idle': {
      // micro-balanço dos braços: é o que separa "parado" de "congelado"
      const s = tri(tMs, 4200);
      pose.rotate.arm_left = round4(-3 * k * s);
      pose.rotate.arm_right = round4(3 * k * s);
      pose.rotate.head = round4(1.5 * k * tri(tMs, 5600));
      break;
    }

    case 'wave': {
      // braço direito sobe e acena; a cabeça acompanha de leve
      const raise = tri01(tMs, 2400);
      const shake = tri(tMs, 600);
      pose.rotate.arm_right = round4(
        -POSE_LIMITS.maxArmDeg * k * (0.55 + 0.45 * raise) + 8 * shake * k,
      );
      pose.rotate.arm_left = round4(-4 * k * tri(tMs, 3000));
      pose.rotate.head = round4(POSE_LIMITS.maxHeadDeg * 0.4 * k * shake);
      break;
    }

    case 'dance': {
      const sway = tri(tMs, 1200);
      pose.rotate.torso = round4(POSE_LIMITS.maxTorsoDeg * k * sway);
      pose.rotate.head = round4(-POSE_LIMITS.maxHeadDeg * 0.5 * k * sway);
      pose.rotate.arm_left = round4(POSE_LIMITS.maxArmDeg * 0.55 * k * sway);
      pose.rotate.arm_right = round4(-POSE_LIMITS.maxArmDeg * 0.55 * k * sway);
      pose.rotate.leg_left = round4(POSE_LIMITS.maxLegDeg * k * sway);
      pose.rotate.leg_right = round4(-POSE_LIMITS.maxLegDeg * k * sway);
      pose.offsetX = round4(0.012 * k * sway);
      pose.offsetY = round4(-0.012 * k * Math.abs(sway));
      break;
    }

    case 'point': {
      // sobe o braço e SEGURA — é o gesto que aponta para a oferta (spike §3.4)
      const settle = clamp(tMs / 400, 0, 1);
      pose.rotate.arm_right = round4(-POSE_LIMITS.maxArmDeg * 0.85 * k * settle);
      pose.rotate.torso = round4(POSE_LIMITS.maxTorsoDeg * 0.5 * k * settle);
      pose.rotate.head = round4(POSE_LIMITS.maxHeadDeg * 0.35 * k * settle);
      break;
    }

    case 'jump': {
      const hop = hop01(tMs, 900);
      pose.offsetY = round4(-POSE_LIMITS.maxHopY * k * hop);
      // agacha antes de subir: squash embaixo, stretch no alto
      pose.scale = round4(breath(tMs) * (1 + POSE_LIMITS.maxSquash * k * (hop - 0.5) * 2));
      pose.rotate.arm_left = round4(-POSE_LIMITS.maxArmDeg * 0.4 * k * hop);
      pose.rotate.arm_right = round4(POSE_LIMITS.maxArmDeg * 0.4 * k * hop);
      pose.rotate.leg_left = round4(-POSE_LIMITS.maxLegDeg * 0.6 * k * hop);
      pose.rotate.leg_right = round4(POSE_LIMITS.maxLegDeg * 0.6 * k * hop);
      break;
    }

    case 'talk': {
      // quem fala gesticula: cabeça marca o ritmo, braços acompanham
      pose.rotate.head = round4(POSE_LIMITS.maxHeadDeg * 0.5 * k * tri(tMs, 900));
      pose.rotate.arm_left = round4(-10 * k * tri01(tMs, 1500));
      pose.rotate.arm_right = round4(10 * k * tri01(tMs, 1300));
      pose.rotate.torso = round4(POSE_LIMITS.maxTorsoDeg * 0.3 * k * tri(tMs, 2600));
      // a boca só é animada de verdade na fatia 3 (visemas + lip-sync)
      pose.mouthOpen = round4(tri01(tMs, 260) * k);
      break;
    }
  }

  return clampPose(pose);
}

/** Garante que nenhum gesto ultrapasse os limites de craft. */
export function clampPose(pose: MascotPose): MascotPose {
  const limit: Record<MascotRigRole, number> = {
    head: POSE_LIMITS.maxHeadDeg,
    torso: POSE_LIMITS.maxTorsoDeg,
    arm_left: POSE_LIMITS.maxArmDeg,
    arm_right: POSE_LIMITS.maxArmDeg,
    leg_left: POSE_LIMITS.maxLegDeg,
    leg_right: POSE_LIMITS.maxLegDeg,
    prop: POSE_LIMITS.maxArmDeg,
  };
  const rotate: MascotPose['rotate'] = {};
  for (const key of Object.keys(pose.rotate) as MascotRigRole[]) {
    const value = pose.rotate[key];
    if (value === undefined) continue;
    rotate[key] = round4(clamp(value, -limit[key], limit[key]));
  }
  return {
    rotate,
    offsetX: round4(clamp(pose.offsetX, -0.5, 0.5)),
    offsetY: round4(clamp(pose.offsetY, -0.5, 0.5)),
    scale: round4(clamp(pose.scale, 0.5, 2)),
    mouthOpen: round4(clamp(pose.mouthOpen, 0, 1)),
  };
}

/** Camada já resolvida para desenho — frações do canvas. */
export interface ResolvedLayer {
  layer: MascotRigLayer;
  left: number;
  top: number;
  width: number;
  height: number;
  rotateDeg: number;
  /** Origem da rotação, em % do próprio elemento (CSS transform-origin). */
  originXPct: number;
  originYPct: number;
  z: number;
}

/**
 * Aplica a pose ao rig. Cada peça sai posicionada e com o ângulo da sua
 * articulação; o deslocamento e a escala globais ficam no container, para que
 * o CSS e o canvas cheguem no mesmo resultado.
 */
export function resolvePose(rig: MascotRig, pose: MascotPose): ResolvedLayer[] {
  return rig.layers
    .filter((layer) => layer.visible !== false)
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((layer) => ({
      layer,
      left: layer.rect.x,
      top: layer.rect.y,
      width: layer.rect.w,
      height: layer.rect.h,
      rotateDeg: pose.rotate[layer.role] ?? 0,
      originXPct: round4(layer.pivot.x * 100),
      originYPct: round4(layer.pivot.y * 100),
      z: layer.z,
    }));
}

export function isRigGesture(value: unknown): value is RigGesture {
  return typeof value === 'string' && (RIG_GESTURES as readonly string[]).includes(value);
}
