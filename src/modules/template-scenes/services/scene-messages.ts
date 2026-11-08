import { EntityManager } from 'typeorm';
import { SceneMessageStatus } from '../domain/scene.types';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';

/** Resposta do assistente no chat (uma por versão que terminou). */
export async function addAssistantMessage(
  manager: EntityManager,
  params: { sceneId: string; versionId: string; content: string; status: SceneMessageStatus },
): Promise<TemplateSceneMessage> {
  return manager.save(
    manager.create(TemplateSceneMessage, {
      sceneId: params.sceneId,
      versionId: params.versionId,
      // A resposta é da face da versão que ela fecha (a versão já está gravada).
      faceIndex: await faceIndexOfVersion(manager, params.versionId),
      role: 'assistant',
      content: params.content,
      status: params.status,
    }),
  );
}

async function faceIndexOfVersion(manager: EntityManager, versionId: string): Promise<number> {
  const version = await manager.findOne(TemplateSceneVersion, {
    where: { id: versionId },
    select: { faceIndex: true },
  });
  return version?.faceIndex ?? 0;
}

/** A mensagem do usuário que originou a versão passa de `queued` ao estado final. */
export async function settleUserMessage(
  manager: EntityManager,
  versionId: string,
  status: SceneMessageStatus,
): Promise<void> {
  await manager.update(TemplateSceneMessage, { versionId, role: 'user' }, { status });
}

/** A mensagem do cliente que originou a versão (a primeira `user` dela), ou `null`. */
export async function turnMessageOf(
  manager: EntityManager,
  version: Pick<TemplateSceneVersion, 'id'>,
): Promise<TemplateSceneMessage | null> {
  return manager.findOne(TemplateSceneMessage, {
    where: { versionId: version.id, role: 'user' },
    order: { createdAt: 'ASC' },
  });
}
