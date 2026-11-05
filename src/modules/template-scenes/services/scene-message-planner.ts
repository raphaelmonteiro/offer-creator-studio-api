import { EntityManager } from 'typeorm';
import { SendMessageDto } from '../dto/send-message.dto';
import { maskBounds, MIN_SHAPE_AREA_RATIO } from '../domain/scene-mask-shape';
import { planFromIntent } from '../domain/scene-intent-plan';
import {
  classifySceneRequest,
  LocalTarget,
  SceneClassification,
} from '../domain/scene-operation.classifier';
import { rasterizeRegion, shapeAreaRatio } from '../domain/scene-shapes';
import { MaskShape, Rect, SceneElement, SceneVersionOperation } from '../domain/scene.types';
import { sceneZonesFor } from '../domain/scene-formats';
import { resolveIntegration } from './scene-integrate';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { invalidBody, regionTooSmall } from '../scene.errors';
import { ConfirmationKind, consumeConfirmation, planOfConfirmation } from './scene-confirmation';
import { currentElements, markedTargetOf, selectedElement } from './scene-plan-context';
import { OPERATION_OF, REPLY_OPERATIONS, replyFor } from './scene-plan-replies';
import { IntentMetrics, IntentOutcome } from './scene-intent.service';

export type { ConfirmationKind, PendingConfirmation } from './scene-confirmation';

/** A mensagem vira um job pago/assíncrono (versão `queued`). */
export interface JobPlan {
  kind: 'job';
  operation: SceneVersionOperation;
  classification: SceneClassification;
  requestedRegion: Rect | null;
  requestedMask: MaskShape | null;
  targetElementId: string | null;
  /** Saída do modelo de intenção desta mensagem (D-19); `null` quando nenhum modelo rodou. */
  intent: IntentMetrics | null;
}

/** A mensagem é respondida na hora, sem job (versão `rejected`, sem chamada de imagem). */
export interface ReplyPlan {
  kind: 'reply';
  operation: SceneVersionOperation;
  classification: SceneClassification;
  reply: string;
  /** Pergunta feita: o pedido original (e o alvo, na edição) ficam guardados para a confirmação. */
  pendingConfirmation: { request: string; kind: ConfirmationKind; target?: LocalTarget } | null;
  intent: IntentMetrics | null;
}

export type MessagePlan = JobPlan | ReplyPlan;

const TARGET_KEYS = ['region', 'mask', 'zone', 'targetElementId'] as const;

/** A confirmação vem sozinha: com alvo ou anexo é 400, e a pergunta segue pendente. */
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
export async function assertShapeBigEnough(
  dto: SendMessageDto,
  scene: TemplateScene,
): Promise<void> {
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

/** A pergunta guarda o pedido (e o alvo, quando a confirmação não o traz de novo). */
function pendingOf(
  classification: SceneClassification,
  request: string,
  marked: LocalTarget | null,
): ReplyPlan['pendingConfirmation'] {
  switch (classification.operation) {
    case 'needs_confirmation_global':
      return { request, kind: 'global' };
    case 'needs_confirmation_new_image':
      return { request, kind: 'new_image' };
    case 'needs_confirmation_edit':
      return { request, kind: 'edit', ...(marked ? { target: marked } : {}) };
    default:
      return null;
  }
}

function toPlan(
  turn: { classification: SceneClassification; intent: IntentMetrics | null },
  scene: TemplateScene,
  dto: SendMessageDto,
): MessagePlan {
  const { classification, intent } = turn;
  const operation = OPERATION_OF[classification.operation];
  if (REPLY_OPERATIONS.has(classification.operation)) {
    return {
      kind: 'reply',
      operation,
      classification,
      reply: replyFor(classification),
      pendingConfirmation: pendingOf(classification, dto.content, markedTargetOf(dto)),
      intent,
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
    intent,
  };
}

/**
 * Sem sinal estruturado, a intenção vem do modelo. Falha do modelo (ou ausência dele, só se o estado
 * mudou entre a conferência e o lock): sem marcação pede a área; com marcação, pergunta se edita.
 */
function classifyByIntent(
  intent: IntentOutcome | null,
  input: { content: string; marked: LocalTarget | null; layers: SceneElement[] },
): SceneClassification {
  if (intent?.status === 'ok') return planFromIntent(intent.intent, input);
  return input.marked
    ? { operation: 'needs_confirmation_edit' }
    : { operation: 'needs_region', reason: 'not_understood' };
}

/**
 * Decide o que fazer com a mensagem (sob o lock da cena): job pago/assíncrono ou resposta imediata.
 * Ordem: a confirmação segue o plano guardado; depois os sinais estruturados (sem versão, anexo,
 * elemento selecionado); o resto vem da intenção reconhecida antes do lock (`intent`).
 */
export async function planMessage(
  manager: EntityManager,
  scene: TemplateScene,
  dto: SendMessageDto,
  intent: IntentOutcome | null,
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
  if (confirmed) {
    return toPlan({ classification: planOfConfirmation(confirmed), intent: null }, scene, dto);
  }
  const layers = hasReadyVersion ? await currentElements(manager, scene) : [];
  const structural = classifySceneRequest({
    hasReadyVersion,
    content: dto.content,
    targetElement,
    attachments: dto.attachments,
  });
  const classification =
    structural ??
    classifyByIntent(intent, { content: dto.content, marked: markedTargetOf(dto), layers });
  const resolved = await resolveIntegration(classification, {
    content: dto.content,
    layers,
    scene: {
      widthPx: scene.widthPx,
      heightPx: scene.heightPx,
      zones: sceneZonesFor(scene.formatId),
    },
  });
  return toPlan(
    { classification: resolved, intent: structural ? null : (intent?.metrics ?? null) },
    scene,
    dto,
  );
}
