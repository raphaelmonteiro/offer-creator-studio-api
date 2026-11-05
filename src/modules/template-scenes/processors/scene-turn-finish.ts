import { EntityManager } from 'typeorm';
import { SceneFailureCode } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { CANCELLED_REPLY, failureReply } from '../scene-texts';
import { publishSceneEvent, SceneEventKind } from '../services/scene-events';
import { bumpRevision } from '../services/scene-lock.service';
import { addAssistantMessage, settleUserMessage } from '../services/scene-messages';

/** Fechamentos da versão (cancelada ou falha) sob o lock da cena: estado, chat, `revision` e evento. */

export function emitVersionEvent(
  manager: EntityManager,
  scene: TemplateScene,
  version: TemplateSceneVersion,
  kind: SceneEventKind,
): Promise<void> {
  return publishSceneEvent(manager, {
    sceneId: scene.id,
    versionId: version.id,
    kind,
    step: version.step,
    status: version.status,
    cancelRequested: version.cancelRequestedAt !== null,
    costUsd: version.providerCostUsd,
    revision: scene.revision,
  });
}

export async function cancelVersion(
  manager: EntityManager,
  scene: TemplateScene,
  version: TemplateSceneVersion,
): Promise<void> {
  version.status = 'cancelled';
  version.cancelRequestedAt = version.cancelRequestedAt ?? new Date();
  await manager.save(version);
  await settleUserMessage(manager, version.id, 'failed');
  await addAssistantMessage(manager, {
    sceneId: scene.id,
    versionId: version.id,
    content: CANCELLED_REPLY,
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
  await manager.save(version);
  await settleUserMessage(manager, version.id, 'failed');
  await addAssistantMessage(manager, {
    sceneId: scene.id,
    versionId: version.id,
    content: failureReply(code),
    status: 'failed',
  });
  await bumpRevision(manager, scene);
  await emitVersionEvent(manager, scene, version, 'version.failed');
}
