import { EntityManager } from 'typeorm';
import { SendMessageDto } from '../dto/send-message.dto';
import { maskBounds, MIN_SHAPE_AREA_RATIO } from '../domain/scene-mask-shape';
import {
  ClassifierTargetElement,
  classifySceneRequest,
  LocalTarget,
  SceneClassification,
} from '../domain/scene-operation.classifier';
import { rasterizeRegion, shapeAreaRatio } from '../domain/scene-shapes';
import { MaskShape, Rect, SceneElement, SceneVersionOperation } from '../domain/scene.types';
import { sceneZonesFor } from '../domain/scene-formats';
import { resolveIntegration } from './scene-integrate';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import {
  confirmationNotPending,
  invalidBody,
  regionTooSmall,
  targetElementNotFound,
} from '../scene.errors';
import {
  GLOBAL_CONFIRM_REPLY,
  MOVE_UNAVAILABLE_REPLY,
  NEW_IMAGE_CONFIRM_REPLY,
  NEEDS_REGION_LAYER_REPLY,
  NEEDS_REGION_REPLY,
  CHOOSE_LAYER_REPLY,
  needsPlaceReply,
} from '../scene-texts';

/** A mensagem vira um job pago/assíncrono (versão `queued`). */
export interface JobPlan {
  kind: 'job';
  operation: SceneVersionOperation;
  classification: SceneClassification;
  requestedRegion: Rect | null;
  requestedMask: MaskShape | null;
  targetElementId: string | null;
}

/** A mensagem é respondida na hora, sem job (versão `rejected`, custo 0). */
export interface ReplyPlan {
  kind: 'reply';
  operation: SceneVersionOperation;
  classification: SceneClassification;
  reply: string;
  /** Ajuste geral perguntado: o pedido original fica guardado para a confirmação. */
  pendingConfirmation: { request: string; kind: ConfirmationKind } | null;
}

export type MessagePlan = JobPlan | ReplyPlan;

/** Marca na versão `rejected` que a pergunta do ajuste geral já foi respondida. */
export type ConfirmationKind = 'global' | 'new_image';

export interface PendingConfirmation {
  request: string;
  /** Tipo da pergunta (D-18); perguntas gravadas antes dele são do ajuste geral. */
  kind?: ConfirmationKind;
  consumedByMessageId?: string;
}

const TARGET_KEYS = ['region', 'mask', 'zone', 'targetElementId'] as const;

/** A confirmação do ajuste geral vem sozinha: com alvo ou anexo é 400, e a pergunta segue pendente. */
function assertConfirmationAlone(dto: SendMessageDto, given: readonly string[]): void {
  if (!dto.confirmGlobal) return;
  if (!dto.replyToMessageId) {
    throw invalidBody('Para confirmar o ajuste geral, envie também replyToMessageId.');
  }
  if (given.length > 0 || (dto.attachments?.length ?? 0) > 0) {
    throw invalidBody(
      'Confirmar o ajuste geral não aceita área, zona, elemento nem anexo: envie só a confirmação.',
    );
  }
}

/** Região, máscara, zona e elemento são alvos exclusivos (400, nada é gravado). */
export function assertSingleTarget(dto: SendMessageDto): void {
  const given = TARGET_KEYS.filter((key) => dto[key] !== undefined && dto[key] !== null);
  if (given.length > 1) {
    throw invalidBody(`Envie um alvo só: ${given.join(', ')} não podem vir juntos.`);
  }
  assertConfirmationAlone(dto, given);
  if (
    dto.region &&
    (dto.region.x + dto.region.w > 1.0001 || dto.region.y + dto.region.h > 1.0001)
  ) {
    throw invalidBody('A região passa da borda da imagem.');
  }
}

/** Área da forma acima de 0,1% da cena; o retângulo é conferido na conta, o pincel e o laço rasterizados. */
async function assertShapeBigEnough(dto: SendMessageDto, scene: TemplateScene): Promise<void> {
  if (dto.region) {
    if (dto.region.w * dto.region.h < MIN_SHAPE_AREA_RATIO) throw regionTooSmall();
    return;
  }
  if (!dto.mask) return;
  const width = 256;
  const height = Math.max(1, Math.round((width * scene.heightPx) / scene.widthPx));
  const shape = await rasterizeRegion(dto.mask, width, height);
  if (shapeAreaRatio(shape) < MIN_SHAPE_AREA_RATIO) throw regionTooSmall();
}

async function currentElements(
  manager: EntityManager,
  scene: TemplateScene,
): Promise<SceneElement[]> {
  if (!scene.currentVersionId) return [];
  const current = await manager.findOne(TemplateSceneVersion, {
    where: { id: scene.currentVersionId },
  });
  return current?.elements ?? [];
}

async function selectedElement(
  manager: EntityManager,
  scene: TemplateScene,
  elementId: string | undefined,
): Promise<ClassifierTargetElement | undefined> {
  if (!elementId) return undefined;
  const element = (await currentElements(manager, scene)).find((e) => e.id === elementId);
  if (!element) throw targetElementNotFound(elementId);
  return { id: element.id, kind: element.kind };
}

/**
 * Resposta do assistente à pergunta do ajuste geral que se confirma: acha a mensagem, confere que a
 * pergunta ainda está pendente e a marca como respondida (mesma transação do envio).
 */
async function consumeConfirmation(
  manager: EntityManager,
  scene: TemplateScene,
  dto: SendMessageDto,
): Promise<{ request: string; kind: ConfirmationKind }> {
  const reply = await manager.findOne(TemplateSceneMessage, {
    where: { id: dto.replyToMessageId, sceneId: scene.id, role: 'assistant' },
  });
  const version = reply?.versionId
    ? await manager.findOne(TemplateSceneVersion, { where: { id: reply.versionId } })
    : null;
  const pending = version?.metrics.pendingConfirmation as PendingConfirmation | undefined;
  if (!version || version.status !== 'rejected' || !pending || pending.consumedByMessageId) {
    throw confirmationNotPending();
  }
  version.metrics = {
    ...version.metrics,
    pendingConfirmation: { ...pending, consumedByMessageId: reply!.id },
  };
  await manager.save(version);
  return { request: pending.request, kind: pending.kind ?? 'global' };
}

/** Alvo da edição: zona vira o retângulo do formato; a forma guarda a caixa; o elemento, o id. */
function requestedTarget(
  target: LocalTarget | null,
  scene: TemplateScene,
): Pick<JobPlan, 'requestedRegion' | 'requestedMask' | 'targetElementId'> {
  const none = { requestedRegion: null, requestedMask: null, targetElementId: null };
  if (!target) return none;
  if (target.kind === 'rect') return { ...none, requestedRegion: target.rect };
  if (target.kind === 'zone')
    return { ...none, requestedRegion: sceneZonesFor(scene.formatId)[target.zone] };
  if (target.kind === 'element') return { ...none, targetElementId: target.elementId };
  return {
    ...none,
    requestedMask: target.mask,
    requestedRegion: maskBounds(target.mask, scene.heightPx / scene.widthPx),
  };
}

const replyFor = (classification: SceneClassification): string => {
  if (classification.operation === 'move_unavailable') return MOVE_UNAVAILABLE_REPLY;
  if (classification.operation === 'needs_confirmation_global') return GLOBAL_CONFIRM_REPLY;
  if (classification.operation === 'needs_confirmation_new_image') return NEW_IMAGE_CONFIRM_REPLY;
  if (classification.operation !== 'needs_region') return NEEDS_REGION_REPLY;
  if (classification.reason === 'layer_visual') return NEEDS_REGION_LAYER_REPLY;
  if (classification.reason === 'place') return needsPlaceReply(classification.subject ?? '');
  return classification.reason === 'choose_layer' ? CHOOSE_LAYER_REPLY : NEEDS_REGION_REPLY;
};

/** Operação gravada na versão (as respostas imediatas usam a mais próxima do pedido). */
const OPERATION_OF: Record<SceneClassification['operation'], SceneVersionOperation> = {
  generate: 'generate',
  global_regenerate: 'generate',
  new_image: 'generate',
  needs_confirmation_new_image: 'generate',
  needs_confirmation_global: 'generate',
  local_edit: 'local_edit',
  needs_region: 'local_edit',
  move_unavailable: 'local_edit',
  add_element: 'add_element',
  set_layer: 'set_layer',
};

function pendingOf(
  classification: SceneClassification,
  request: string,
): ReplyPlan['pendingConfirmation'] {
  if (classification.operation === 'needs_confirmation_global') return { request, kind: 'global' };
  if (classification.operation === 'needs_confirmation_new_image') {
    return { request, kind: 'new_image' };
  }
  return null;
}

function toPlan(
  classification: SceneClassification,
  scene: TemplateScene,
  dto: SendMessageDto,
): MessagePlan {
  const operation = OPERATION_OF[classification.operation];
  if (
    classification.operation === 'needs_region' ||
    classification.operation === 'move_unavailable' ||
    classification.operation === 'needs_confirmation_global' ||
    classification.operation === 'needs_confirmation_new_image'
  ) {
    return {
      kind: 'reply',
      operation,
      classification,
      reply: replyFor(classification),
      pendingConfirmation: pendingOf(classification, dto.content),
    };
  }
  const target =
    classification.operation === 'local_edit' || classification.operation === 'add_element'
      ? classification.target
      : null;
  return {
    kind: 'job',
    operation,
    classification,
    ...requestedTarget(target, scene),
    targetElementId: target?.kind === 'element' ? target.elementId : null,
  };
}

/** Decide o que fazer com a mensagem (sob o lock da cena): job pago/assíncrono ou resposta imediata. */
export async function planMessage(
  manager: EntityManager,
  scene: TemplateScene,
  dto: SendMessageDto,
): Promise<MessagePlan> {
  assertSingleTarget(dto);
  const hasReadyVersion = await manager.exists(TemplateSceneVersion, {
    where: { sceneId: scene.id, status: 'ready' },
  });
  if (hasReadyVersion) await assertShapeBigEnough(dto, scene);
  const targetElement = hasReadyVersion
    ? await selectedElement(manager, scene, dto.targetElementId)
    : undefined;
  const confirmed = dto.confirmGlobal ? await consumeConfirmation(manager, scene, dto) : null;
  const classification = classifySceneRequest({
    hasReadyVersion,
    content: confirmed?.request ?? dto.content,
    confirmKind: confirmed?.kind,
    region: dto.region,
    mask: dto.mask,
    zone: dto.zone,
    targetElement,
    attachments: dto.attachments,
    confirmGlobal: dto.confirmGlobal,
  });
  const resolved = await resolveIntegration(classification, {
    content: confirmed?.request ?? dto.content,
    layers: hasReadyVersion ? await currentElements(manager, scene) : [],
    scene: {
      widthPx: scene.widthPx,
      heightPx: scene.heightPx,
      zones: sceneZonesFor(scene.formatId),
    },
  });
  return toPlan(resolved, scene, dto);
}
