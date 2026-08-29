/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ MÓDULO ESPELHADO — mantenha idêntico em:                                │
 * │   backend/src/modules/mascots/domain/rig.types.ts                       │
 * │   frontend/src/utils/mascot/rigTypes.ts                                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Formato do rig 2D (spike §6) — a marionete montada UMA VEZ a partir do PNG
 * do cliente. Depois disso, toda animação é matemática determinística sobre os
 * pixels originais: nenhuma etapa redesenha o mascote.
 *
 * Convenção de coordenadas, para os dois renderers concordarem:
 * - `rect` é a posição da camada NO CANVAS, em frações [0..1].
 * - `pivot` é o ponto de rotação DENTRO da própria camada, em frações [0..1]
 *   do `rect` dela. Assim redimensionar o canvas não move articulação.
 */

/** Papéis da v1 — congelados (spike risco 9). */
export const RIG_ROLES = [
  'head',
  'torso',
  'arm_left',
  'arm_right',
  'leg_left',
  'leg_right',
  'prop',
] as const;
export type MascotRigRole = (typeof RIG_ROLES)[number];

export const RIG_JOINTS = ['neck', 'shoulder', 'elbow', 'hip'] as const;
export type MascotRigJoint = (typeof RIG_JOINTS)[number];

export interface RigRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RigPoint {
  x: number;
  y: number;
}

export interface MascotRigLayer {
  id: string;
  role: MascotRigRole;
  /** PNG RGBA da camada. `null` enquanto o recorte não foi gerado. */
  url: string | null;
  /** Onde a camada fica no canvas (frações do canvas). */
  rect: RigRect;
  /** Ordem de desenho: maior = mais na frente. */
  z: number;
  /** Ponto de rotação, em frações do `rect` da própria camada. */
  pivot: RigPoint;
  joints?: MascotRigJoint[];
  visible?: boolean;
}

/**
 * Boca procedural (spike §3.1 item 4): a v1 deforma o sprite da região da boca
 * em vez de exigir 6 sprites desenhados. `openScale` é o quanto a boca abre no
 * visema mais aberto.
 */
export interface MascotRigMouth {
  anchor: RigPoint;
  /** Tamanho da região da boca, em frações do canvas. */
  width: number;
  height: number;
  mode: 'procedural' | 'sprites';
  openScale: number;
  /** Preenchido só no modo `sprites` (Fase 3, fatia 3). */
  shapes?: Record<string, string>;
}

export interface MascotRigEyes {
  left: RigPoint;
  right: RigPoint;
  /** Raio do olho em frações da largura do canvas. */
  radius: number;
  /** Intervalo aleatório entre piscadas, em ms (spike §3.6). */
  blinkEveryMs: [number, number];
}

export interface MascotRig {
  version: 1;
  canvas: { w: number; h: number };
  layers: MascotRigLayer[];
  mouth: MascotRigMouth;
  eyes: MascotRigEyes;
  /** Como o rig foi montado — `manual` depois que o usuário edita. */
  source: 'auto' | 'ai' | 'manual';
}

export function isMascotRig(value: unknown): value is MascotRig {
  if (typeof value !== 'object' || value === null) return false;
  const rig = value as Partial<MascotRig>;
  return rig.version === 1 && Array.isArray(rig.layers) && rig.layers.length > 0;
}

/** Ordem de desenho padrão: braço de trás, tronco, pernas, cabeça, braço da frente. */
export const DEFAULT_Z_BY_ROLE: Record<MascotRigRole, number> = {
  arm_left: 10,
  torso: 20,
  leg_left: 25,
  leg_right: 26,
  head: 30,
  arm_right: 40,
  prop: 50,
};

export const ROLE_LABELS_PT: Record<MascotRigRole, string> = {
  head: 'Cabeça',
  torso: 'Tronco',
  arm_left: 'Braço esquerdo',
  arm_right: 'Braço direito',
  leg_left: 'Perna esquerda',
  leg_right: 'Perna direita',
  prop: 'Adereço',
};
