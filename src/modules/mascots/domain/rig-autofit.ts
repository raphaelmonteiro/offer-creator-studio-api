/**
 * Auto-rig heurístico — desmonta o mascote em peças SEM IA.
 *
 * Por que sem IA: o spike (risco 2) diz que "automação é aceleração, não
 * pré-requisito", e o editor de rig é que dá a palavra final. Uma heurística
 * geométrica sobre o canal alpha acerta a maior parte dos mascotes de varejo
 * (personagem de pé, de frente), é determinística, custa zero e roda em
 * milissegundos. A segmentação por SAM entra depois, como refinamento, sem
 * mudar nada daqui para baixo.
 *
 * Tudo neste arquivo é função pura: entra o PERFIL DE ALPHA (quais pixels são
 * opacos em cada linha), sai a divisão em regiões e os pivôs. Nenhum I/O,
 * nenhum pixel — por isso dá para testar com perfis sintéticos.
 *
 * "left"/"right" são do ponto de vista de QUEM OLHA, não do personagem: é o
 * lado que o usuário vê quando arrasta a peça no editor.
 */

import { DEFAULT_Z_BY_ROLE, MascotRig, MascotRigLayer, MascotRigRole, RigRect } from './rig.types';

/** Extensão horizontal dos pixels opacos numa linha. */
export interface RowSpan {
  /** Menor x opaco. */
  min: number;
  /** Maior x opaco. */
  max: number;
  /** Quantos pixels opacos — menor que o vão quando há buraco (ex.: entre as pernas). */
  count: number;
}

export interface AlphaProfile {
  width: number;
  height: number;
  /** Um item por linha y. `null` = linha inteiramente transparente. */
  rows: (RowSpan | null)[];
}

export interface RigLayout {
  canvas: { w: number; h: number };
  /** Caixa do personagem dentro do canvas, em pixels. */
  bbox: { left: number; top: number; right: number; bottom: number };
  /** Linha do pescoço: fim da cabeça. */
  neckY: number;
  /** Linha dos ombros: onde os braços começam. */
  shoulderY: number;
  /** Linha do quadril: onde as pernas começam. */
  hipY: number;
  /** Eixo central do corpo. */
  centerX: number;
  /** Colunas que delimitam o tronco; fora delas são braços. */
  torsoLeft: number;
  torsoRight: number;
  hasLeftArm: boolean;
  hasRightArm: boolean;
  hasLegs: boolean;
}

export const RIG_TUNING = {
  /** Faixa vertical onde procuramos o pescoço (frações da altura do corpo). */
  neckSearch: [0.15, 0.55] as const,
  /** O pescoço precisa ser mais estreito que isto vezes a maior largura da cabeça. */
  neckMaxWidthRatio: 0.72,
  /** Sem pescoço detectável (personagem "bolha"), a cabeça fica com esta fração. */
  headFallback: 0.34,
  /** Quanto abaixo do pescoço ficam os ombros. */
  shoulderDrop: 0.03,
  /** Faixa vertical onde procuramos o quadril. */
  hipSearch: [0.55, 0.88] as const,
  /** Vão/preenchimento abaixo disto indica que as pernas se separaram. */
  legGapRatio: 0.75,
  hipFallback: 0.7,
  /** Folga lateral aplicada à largura do tronco medida no quadril. */
  torsoWidthSlack: 1.06,
  minTorsoHalf: 0.16,
  maxTorsoHalf: 0.46,
  /** Braço/perna com menos que isto de área é descartado. */
  minLimbAreaRatio: 0.012,
  /**
   * Só existe braço se o corpo for visivelmente mais largo na faixa dos ombros
   * do que no quadril. Sem esse degrau (um bloco de largura constante), não há
   * o que separar — e chutar dois "braços" nas laterais seria pior que não ter.
   */
  minArmSpreadRatio: 0.1,
  /** Braços descem um pouco abaixo do quadril. */
  armBottomExtra: 0.08,
  /** Boca e olhos como fração da altura/largura da cabeça. */
  mouthY: 0.64,
  mouthWidth: 0.3,
  mouthHeight: 0.17,
  eyesY: 0.42,
  eyesOffsetX: 0.19,
  eyesRadius: 0.07,
  mouthOpenScale: 2.2,
} as const;

const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v);

function spanWidth(row: RowSpan | null): number {
  return row ? row.max - row.min + 1 : 0;
}

/**
 * Encontra as linhas de corte do corpo a partir do perfil de alpha.
 * Devolve `null` quando não há pixel opaco nenhum (recorte vazio).
 */
export function computeRigLayout(profile: AlphaProfile): RigLayout | null {
  const { width, height, rows } = profile;
  let top = -1;
  let bottom = -1;
  let left = Number.POSITIVE_INFINITY;
  let right = -1;
  let totalCount = 0;

  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y];
    if (!row || row.count === 0) continue;
    if (top === -1) top = y;
    bottom = y;
    if (row.min < left) left = row.min;
    if (row.max > right) right = row.max;
    totalCount += row.count;
  }
  if (top === -1 || right === -1) return null;

  const bodyTop = top;
  const bodyHeight = bottom - top + 1;
  const rowAt = (y: number) => rows[clamp(Math.round(y), 0, rows.length - 1)] ?? null;
  const atFraction = (f: number) => bodyTop + f * bodyHeight;

  // ── pescoço: linha mais estreita na parte de cima ──
  const neckFrom = Math.round(atFraction(RIG_TUNING.neckSearch[0]));
  const neckTo = Math.round(atFraction(RIG_TUNING.neckSearch[1]));
  let headMaxWidth = 0;
  for (let y = bodyTop; y <= neckTo; y += 1) {
    headMaxWidth = Math.max(headMaxWidth, spanWidth(rowAt(y)));
  }
  let neckY = -1;
  let neckWidth = Number.POSITIVE_INFINITY;
  for (let y = neckFrom; y <= neckTo; y += 1) {
    const w = spanWidth(rowAt(y));
    if (w > 0 && w < neckWidth) {
      neckWidth = w;
      neckY = y;
    }
  }
  const neckDetected =
    neckY !== -1 && headMaxWidth > 0 && neckWidth <= headMaxWidth * RIG_TUNING.neckMaxWidthRatio;
  if (!neckDetected) {
    neckY = Math.round(atFraction(RIG_TUNING.headFallback));
  }

  const shoulderY = clamp(
    Math.round(neckY + RIG_TUNING.shoulderDrop * bodyHeight),
    neckY + 1,
    bottom,
  );

  // ── quadril: onde o preenchimento abre (as pernas se separam) ──
  const hipFrom = Math.round(atFraction(RIG_TUNING.hipSearch[0]));
  const hipTo = Math.round(atFraction(RIG_TUNING.hipSearch[1]));
  let hipY = -1;
  for (let y = hipFrom; y <= hipTo; y += 1) {
    const row = rowAt(y);
    const span = spanWidth(row);
    if (!row || span === 0) continue;
    if (row.count / span < RIG_TUNING.legGapRatio) {
      hipY = y;
      break;
    }
  }
  const hasLegs = hipY !== -1;
  if (!hasLegs) hipY = Math.round(atFraction(RIG_TUNING.hipFallback));
  hipY = clamp(hipY, shoulderY + 1, bottom);

  // ── eixo central e largura do tronco ──
  const centers: number[] = [];
  for (let y = shoulderY; y <= hipY; y += 1) {
    const row = rowAt(y);
    if (row && row.count > 0) centers.push((row.min + row.max) / 2);
  }
  centers.sort((a, b) => a - b);
  const centerX = centers.length > 0 ? centers[Math.floor(centers.length / 2)] : (left + right) / 2;

  // No quadril normalmente não há braço: a largura ali é a do tronco.
  const hipRow = rowAt(hipY - Math.max(1, Math.round(bodyHeight * 0.02)));
  const measured = spanWidth(hipRow) / 2;
  const bodyWidth = right - left + 1;
  const torsoHalf = clamp(
    measured * RIG_TUNING.torsoWidthSlack,
    bodyWidth * RIG_TUNING.minTorsoHalf,
    bodyWidth * RIG_TUNING.maxTorsoHalf,
  );
  const torsoLeft = Math.max(left, centerX - torsoHalf);
  const torsoRight = Math.min(right, centerX + torsoHalf);

  // ── braços existem? mede a área fora das colunas do tronco ──
  const armBottom = clamp(Math.round(hipY + RIG_TUNING.armBottomExtra * bodyHeight), hipY, bottom);
  let leftArmArea = 0;
  let rightArmArea = 0;
  let maxArmBandSpan = 0;
  for (let y = shoulderY; y <= armBottom; y += 1) {
    const row = rowAt(y);
    if (!row || row.count === 0) continue;
    maxArmBandSpan = Math.max(maxArmBandSpan, spanWidth(row));
    if (row.min < torsoLeft) leftArmArea += Math.min(row.max, torsoLeft) - row.min;
    if (row.max > torsoRight) rightArmArea += row.max - Math.max(row.min, torsoRight);
  }
  const minArea = totalCount * RIG_TUNING.minLimbAreaRatio;
  // degrau de largura entre ombros e quadril — sem ele, não há braço a separar
  const armSpread = maxArmBandSpan - measured * 2;
  const hasArmSpread = armSpread >= bodyWidth * RIG_TUNING.minArmSpreadRatio;

  return {
    canvas: { w: width, h: height },
    bbox: { left, top, right, bottom },
    neckY,
    shoulderY,
    hipY,
    centerX,
    torsoLeft,
    torsoRight,
    hasLeftArm: hasArmSpread && leftArmArea >= minArea,
    hasRightArm: hasArmSpread && rightArmArea >= minArea,
    hasLegs,
  };
}

/**
 * A qual peça um pixel opaco pertence. As regiões **ladrilham** o personagem
 * sem sobreposição — é isso que permite mover um braço sem arrastar o tronco
 * junto, e é isso que cria o buraco que o tronco precisa cicatrizar depois.
 */
export function regionAt(layout: RigLayout, x: number, y: number): MascotRigRole {
  if (y <= layout.neckY) return 'head';

  const armBottom =
    layout.hipY + RIG_TUNING.armBottomExtra * (layout.bbox.bottom - layout.bbox.top + 1);
  if (y >= layout.shoulderY && y <= armBottom) {
    if (layout.hasLeftArm && x < layout.torsoLeft) return 'arm_left';
    if (layout.hasRightArm && x > layout.torsoRight) return 'arm_right';
  }

  if (layout.hasLegs && y > layout.hipY) {
    return x < layout.centerX ? 'leg_left' : 'leg_right';
  }

  return 'torso';
}

/** Caixa real (em pixels) ocupada por cada papel, medida pelo serviço. */
export type RegionBoxes = Partial<
  Record<MascotRigRole, { left: number; top: number; width: number; height: number }>
>;

/**
 * Pivô de cada peça, em frações do retângulo DELA MESMA.
 * - cabeça gira no pescoço (base, centro);
 * - braço gira no ombro — o canto de cima do lado do tronco;
 * - perna gira no quadril; tronco gira na base.
 */
export function pivotForRole(role: MascotRigRole): { x: number; y: number } {
  switch (role) {
    case 'head':
      return { x: 0.5, y: 0.97 };
    case 'arm_left':
      return { x: 0.85, y: 0.12 };
    case 'arm_right':
      return { x: 0.15, y: 0.12 };
    case 'leg_left':
    case 'leg_right':
      return { x: 0.5, y: 0.06 };
    case 'torso':
      return { x: 0.5, y: 0.98 };
    default:
      return { x: 0.5, y: 0.5 };
  }
}

const JOINTS_BY_ROLE: Partial<Record<MascotRigRole, MascotRigLayer['joints']>> = {
  head: ['neck'],
  arm_left: ['shoulder', 'elbow'],
  arm_right: ['shoulder', 'elbow'],
  leg_left: ['hip'],
  leg_right: ['hip'],
};

/** Monta o rig final a partir do layout e das caixas medidas em pixels. */
export function buildRigFromRegions(
  layout: RigLayout,
  boxes: RegionBoxes,
  urls: Partial<Record<MascotRigRole, string>> = {},
  source: MascotRig['source'] = 'auto',
): MascotRig {
  const { w, h } = layout.canvas;
  const toRect = (box: { left: number; top: number; width: number; height: number }): RigRect => ({
    x: box.left / w,
    y: box.top / h,
    w: box.width / w,
    h: box.height / h,
  });

  const layers: MascotRigLayer[] = [];
  for (const role of Object.keys(boxes) as MascotRigRole[]) {
    const box = boxes[role];
    if (!box || box.width <= 0 || box.height <= 0) continue;
    layers.push({
      id: role,
      role,
      url: urls[role] ?? null,
      rect: toRect(box),
      z: DEFAULT_Z_BY_ROLE[role],
      pivot: pivotForRole(role),
      ...(JOINTS_BY_ROLE[role] ? { joints: JOINTS_BY_ROLE[role] } : {}),
      visible: true,
    });
  }
  layers.sort((a, b) => a.z - b.z);

  // Boca e olhos são posicionados dentro da cabeça — o usuário ajusta no editor
  // (é o que faz o rig funcionar para mascote sem rosto humano, spike risco 1).
  const headBox = boxes.head;
  const headLeft = headBox ? headBox.left : layout.bbox.left;
  const headTop = headBox ? headBox.top : layout.bbox.top;
  const headWidth = headBox ? headBox.width : layout.bbox.right - layout.bbox.left + 1;
  const headHeight = headBox ? headBox.height : layout.neckY - layout.bbox.top + 1;
  const headCenterX = headLeft + headWidth / 2;

  return {
    version: 1,
    canvas: { w, h },
    layers,
    mouth: {
      anchor: {
        x: headCenterX / w,
        y: (headTop + RIG_TUNING.mouthY * headHeight) / h,
      },
      width: (RIG_TUNING.mouthWidth * headWidth) / w,
      height: (RIG_TUNING.mouthHeight * headHeight) / h,
      mode: 'procedural',
      openScale: RIG_TUNING.mouthOpenScale,
    },
    eyes: {
      left: {
        x: (headCenterX - RIG_TUNING.eyesOffsetX * headWidth) / w,
        y: (headTop + RIG_TUNING.eyesY * headHeight) / h,
      },
      right: {
        x: (headCenterX + RIG_TUNING.eyesOffsetX * headWidth) / w,
        y: (headTop + RIG_TUNING.eyesY * headHeight) / h,
      },
      radius: (RIG_TUNING.eyesRadius * headWidth) / w,
      blinkEveryMs: [2800, 5200],
    },
    source,
  };
}
