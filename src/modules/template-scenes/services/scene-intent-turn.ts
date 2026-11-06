import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { SendMessageDto } from '../dto/send-message.dto';
import { classifySceneRequest } from '../domain/scene-operation.classifier';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { assertShapeBigEnough, assertSingleTarget } from './scene-message-target';
import { currentElements, markedTargetOf, selectedElement } from './scene-plan-context';
import { assertExpectedRevision, assertSceneIdle } from './scene-lock.service';
import { IntentMetrics, IntentOutcome, SceneIntentService } from './scene-intent.service';

/**
 * Reconhece a intenção ANTES do lock (D-19): a chamada ao modelo não pode segurar o lock nem a
 * transação da cena. Confere `expectedRevision`, `SCENE_BUSY` e o corpo sem lock, só para não pagar à
 * toa: qualquer problema devolve `null`, e é o caminho sob o lock que responde o erro de sempre.
 * Também devolve `null` quando o pedido não precisa do modelo (sem versão pronta, confirmação, anexo,
 * elemento selecionado) ou a cena não existe.
 */
export async function recognizeIntent(
  dataSource: DataSource,
  intent: SceneIntentService,
  sceneId: string,
  dto: SendMessageDto,
): Promise<IntentOutcome | null> {
  const { manager } = dataSource;
  try {
    const scene = await manager.findOne(TemplateScene, { where: { id: sceneId } });
    if (!scene) return null;
    assertExpectedRevision(scene, dto.expectedRevision);
    await assertSceneIdle(manager, sceneId);
    assertSingleTarget(dto);
    await assertShapeBigEnough(dto, scene);
    const hasReadyVersion = await manager.exists(TemplateSceneVersion, {
      where: { sceneId, status: 'ready' },
    });
    if (!hasReadyVersion || dto.confirmGlobal) return null;
    const targetElement = await selectedElement(manager, scene, dto.targetElementId);
    const structural = classifySceneRequest({
      hasReadyVersion,
      content: dto.content,
      targetElement,
      attachments: dto.attachments,
    });
    if (structural) return null;
    const layers = await currentElements(manager, scene);
    return await intent.classify({
      message: dto.content,
      context: {
        marked: markedTargetOf(dto) !== null,
        layers: layers.map((layer) => ({ name: layer.name, kind: layer.kind })),
      },
      correlationId: randomUUID(),
    });
  } catch {
    return null;
  }
}

/** Custo da intenção na versão nova e na cena (sob o lock); sem modelo, nada muda. */
export function intentCostFields(
  scene: TemplateScene,
  intent: IntentMetrics | null,
): { providerCostUsd: number; metrics: { intent?: IntentMetrics } } {
  const cost = intent?.costUsd ?? 0;
  scene.totalCostUsd = Math.round((scene.totalCostUsd + cost) * 1_000_000) / 1_000_000;
  return { providerCostUsd: cost, metrics: intent ? { intent } : {} };
}

/** A intenção foi paga e a mensagem não gravou (conflito na segunda conferência): o custo fica só no log. */
export function logLostIntent(logger: Logger, sceneId: string, intent: IntentOutcome | null): void {
  if (!intent?.metrics.costUsd) return;
  logger.warn(
    `Intenção paga e descartada (cena ${sceneId}): US$ ${intent.metrics.costUsd} (${intent.metrics.status})`,
  );
}
