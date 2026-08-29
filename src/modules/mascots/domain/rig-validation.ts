/**
 * Validação do rig editado à mão.
 *
 * O rig chega do editor como JSON livre — e é ele que manda no renderer. Um rig
 * malformado não pode virar 500 nem um vídeo quebrado: aqui ele é recusado com
 * mensagem que diz o que consertar, em pt-BR.
 *
 * Função pura: sem Nest, sem I/O, testável direto.
 */

import {
  MascotRig,
  MascotRigJoint,
  MascotRigLayer,
  MascotRigRole,
  RIG_JOINTS,
  RIG_ROLES,
} from './rig.types';

const isRigRole = (v: unknown): v is MascotRigRole =>
  typeof v === 'string' && (RIG_ROLES as readonly string[]).includes(v);

const isRigJoint = (v: unknown): v is MascotRigJoint =>
  typeof v === 'string' && (RIG_JOINTS as readonly string[]).includes(v);

export class RigValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'RigValidationError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isFraction = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function requireFraction(value: unknown, field: string): number {
  if (!isFraction(value)) {
    throw new RigValidationError(
      `O campo "${field}" precisa ser um número entre 0 e 1 (fração do canvas).`,
      field,
    );
  }
  return value;
}

function parsePoint(value: unknown, field: string): { x: number; y: number } {
  if (!isRecord(value)) {
    throw new RigValidationError(`O campo "${field}" precisa ter x e y.`, field);
  }
  return {
    x: requireFraction(value.x, `${field}.x`),
    y: requireFraction(value.y, `${field}.y`),
  };
}

function parseLayer(value: unknown, index: number): MascotRigLayer {
  const field = `layers[${index}]`;
  if (!isRecord(value)) {
    throw new RigValidationError(`A camada ${index + 1} do rig está inválida.`, field);
  }
  const role = value.role;
  if (!isRigRole(role)) {
    throw new RigValidationError(
      `A peça ${index + 1} tem um papel desconhecido. Use um de: ${RIG_ROLES.join(', ')}.`,
      `${field}.role`,
    );
  }
  const rect = isRecord(value.rect) ? value.rect : null;
  if (!rect) {
    throw new RigValidationError(`A peça "${role}" está sem posição no canvas.`, `${field}.rect`);
  }
  const w = requireFraction(rect.w, `${field}.rect.w`);
  const h = requireFraction(rect.h, `${field}.rect.h`);
  if (w <= 0 || h <= 0) {
    throw new RigValidationError(`A peça "${role}" ficou sem tamanho.`, `${field}.rect`);
  }

  const joints = Array.isArray(value.joints) ? value.joints.filter(isRigJoint) : undefined;

  return {
    id: typeof value.id === 'string' && value.id ? value.id : role,
    role,
    url: typeof value.url === 'string' && value.url ? value.url : null,
    rect: {
      x: requireFraction(rect.x, `${field}.rect.x`),
      y: requireFraction(rect.y, `${field}.rect.y`),
      w,
      h,
    },
    z: typeof value.z === 'number' && Number.isFinite(value.z) ? Math.round(value.z) : 0,
    pivot: parsePoint(value.pivot, `${field}.pivot`),
    ...(joints && joints.length > 0 ? { joints } : {}),
    visible: value.visible !== false,
  };
}

/**
 * Normaliza e valida um rig vindo do editor. Devolve uma cópia limpa —
 * campos desconhecidos são descartados, para o JSON persistido não virar
 * depósito de lixo do frontend.
 */
export function parseRig(value: unknown): MascotRig {
  if (!isRecord(value)) {
    throw new RigValidationError('O rig enviado está vazio ou inválido.');
  }
  if (value.version !== 1) {
    throw new RigValidationError(
      'Versão de rig não suportada por esta versão do editor.',
      'version',
    );
  }
  const canvas = isRecord(value.canvas) ? value.canvas : null;
  if (!canvas || typeof canvas.w !== 'number' || typeof canvas.h !== 'number') {
    throw new RigValidationError('O rig está sem as dimensões do canvas.', 'canvas');
  }
  if (canvas.w <= 0 || canvas.h <= 0) {
    throw new RigValidationError('As dimensões do canvas do rig são inválidas.', 'canvas');
  }

  if (!Array.isArray(value.layers) || value.layers.length === 0) {
    throw new RigValidationError('O rig precisa de pelo menos uma peça.', 'layers');
  }
  const layers = value.layers.map(parseLayer);

  const seen = new Set<string>();
  for (const layer of layers) {
    if (seen.has(layer.id)) {
      throw new RigValidationError(
        `Há duas peças com o mesmo identificador "${layer.id}".`,
        'layers',
      );
    }
    seen.add(layer.id);
  }
  if (!layers.some((l) => l.role === 'torso' || l.role === 'head')) {
    throw new RigValidationError(
      'O rig precisa de pelo menos uma cabeça ou um tronco para poder ser animado.',
      'layers',
    );
  }

  const mouth = isRecord(value.mouth) ? value.mouth : null;
  const eyes = isRecord(value.eyes) ? value.eyes : null;
  if (!mouth) throw new RigValidationError('O rig está sem a âncora da boca.', 'mouth');
  if (!eyes) throw new RigValidationError('O rig está sem a posição dos olhos.', 'eyes');

  const blink = Array.isArray(eyes.blinkEveryMs) ? eyes.blinkEveryMs : [2800, 5200];
  const blinkMin = typeof blink[0] === 'number' ? blink[0] : 2800;
  const blinkMax = typeof blink[1] === 'number' ? blink[1] : 5200;

  return {
    version: 1,
    canvas: { w: Math.round(canvas.w), h: Math.round(canvas.h) },
    layers: layers.sort((a, b) => a.z - b.z),
    mouth: {
      anchor: parsePoint(mouth.anchor, 'mouth.anchor'),
      width: requireFraction(mouth.width, 'mouth.width'),
      height: requireFraction(mouth.height, 'mouth.height'),
      mode: mouth.mode === 'sprites' ? 'sprites' : 'procedural',
      openScale:
        typeof mouth.openScale === 'number' && mouth.openScale > 1 && mouth.openScale <= 6
          ? mouth.openScale
          : 2.2,
      ...(isRecord(mouth.shapes) ? { shapes: mouth.shapes as Record<string, string> } : {}),
    },
    eyes: {
      left: parsePoint(eyes.left, 'eyes.left'),
      right: parsePoint(eyes.right, 'eyes.right'),
      radius: requireFraction(eyes.radius, 'eyes.radius'),
      blinkEveryMs: [Math.max(500, blinkMin), Math.max(blinkMin + 1, blinkMax)],
    },
    source: value.source === 'ai' ? 'ai' : value.source === 'auto' ? 'auto' : 'manual',
  };
}
