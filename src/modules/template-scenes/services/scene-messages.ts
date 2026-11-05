import { EntityManager } from 'typeorm';
import { SceneMessageStatus } from '../domain/scene.types';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';

/** Resposta do assistente no chat (uma por versão que terminou). */
export async function addAssistantMessage(
  manager: EntityManager,
  params: { sceneId: string; versionId: string; content: string; status: SceneMessageStatus },
): Promise<void> {
  await manager.insert(TemplateSceneMessage, {
    sceneId: params.sceneId,
    versionId: params.versionId,
    role: 'assistant',
    content: params.content,
    status: params.status,
  });
}

/** A mensagem do usuário que originou a versão passa de `queued` ao estado final. */
export async function settleUserMessage(
  manager: EntityManager,
  versionId: string,
  status: SceneMessageStatus,
): Promise<void> {
  await manager.update(TemplateSceneMessage, { versionId, role: 'user' }, { status });
}
