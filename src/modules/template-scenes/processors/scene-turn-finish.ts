import { EntityManager } from 'typeorm';
import { SceneFailureCode } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { CANCELLED_REPLY, failureReply, NO_LAYER_CHANGED } from '../scene-texts';
import { QueuePort } from '../../../shared/queue/animation-queue.service';
import { faceKeyOfVersion } from '../services/scene-faces';
import { publishSceneEvent, publishVersionReady, SceneEventKind } from '../services/scene-events';
import { bumpRevision } from '../services/scene-lock.service';
import { addAssistantMessage, settleUserMessage } from '../services/scene-messages';
import { settleReferenceOnStop } from '../services/scene-reference-state';
import { closeTurnBrief } from '../services/scene-turn-brief';

/** Fechamentos da versão (cancelada ou falha) sob o lock da cena: estado, chat, `revision` e evento. */

function versionEventOf(scene: TemplateScene, version: TemplateSceneVersion) {
  return {
    sceneId: scene.id,
    versionId: version.id,
    faceKey: faceKeyOfVersion(scene, version),
    step: version.step,
    status: version.status,
    cancelRequested: version.cancelRequestedAt !== null,
    costUsd: version.providerCostUsd,
    revision: scene.revision,
  };
}

export function emitVersionEvent(
  manager: EntityManager,
  scene: TemplateScene,
  version: TemplateSceneVersion,
  kind: SceneEventKind,
): Promise<void> {
  return publishSceneEvent(manager, { ...versionEventOf(scene, version), kind });
}

/** `version.ready` mais o job de sincronização do template, na mesma transação (PV-11). */
export function emitVersionReady(
  manager: EntityManager,
  queue: Pick<QueuePort, 'publish'>,
  scene: TemplateScene,
  version: TemplateSceneVersion,
): Promise<void> {
  return publishVersionReady(manager, queue, versionEventOf(scene, version));
}

/** O plano que chamava imagem trazia camadas: diz que nenhuma foi alterada, porque a imagem não saiu. */
function withLayerNote(text: string, version: TemplateSceneVersion): string {
  const plan = version.metrics?.plan as { layer_ops?: unknown[] } | undefined;
  return plan?.layer_ops?.length ? `${text} ${NO_LAYER_CHANGED}` : text;
}

export async function cancelVersion(
  manager: EntityManager,
  scene: TemplateScene,
  version: TemplateSceneVersion,
): Promise<void> {
  version.status = 'cancelled';
  version.cancelRequestedAt = version.cancelRequestedAt ?? new Date();
  // Parar fecha o pedido do turno parado e o que sobrou do anterior (D-59).
  await closeTurnBrief(manager, scene, version, { stopped: true });
  await settleReferenceOnStop(manager, version);
  await manager.save(version);
  await settleUserMessage(manager, version.id, 'failed');
  await addAssistantMessage(manager, {
    sceneId: scene.id,
    versionId: version.id,
    content: withLayerNote(CANCELLED_REPLY, version),
    status: 'done',
  });
  await bumpRevision(manager, scene);
  await emitVersionEvent(manager, scene, version, 'version.cancelled');
}

export async function failVersion(
  manager: EntityManager,
  scene: TemplateScene,
  version: TemplateSceneVersion,
  code: SceneFailureCode,
): Promise<void> {
  version.status = 'failed';
  version.errorCode = code;
  await closeTurnBrief(manager, scene, version);
  await settleReferenceOnStop(manager, version);
  await manager.save(version);
  await settleUserMessage(manager, version.id, 'failed');
  await addAssistantMessage(manager, {
    sceneId: scene.id,
    versionId: version.id,
    content: withLayerNote(failureReply(code), version),
    status: 'failed',
  });
  await bumpRevision(manager, scene);
  await emitVersionEvent(manager, scene, version, 'version.failed');
}
