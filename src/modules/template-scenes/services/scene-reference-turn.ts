import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { FaceKey } from '../domain/scene-faces';
import { SceneVersionMetrics, SceneVersionOperation } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { bumpRevision, nextVersionNumber } from './scene-lock.service';
import { publishQueued } from './scene-turn-helpers';
import { TURN_EXPIRE_SECONDS } from './scene-turn.service';

/** Resposta das três rotas da referência (202): a mensagem, a versão e o job existem antes de o worker rodar. */
export interface ReferenceTurnResult {
  messageId: string;
  versionId: string;
  jobId: string;
  revision: number;
}

export interface ReferenceTurnInput {
  operation: Extract<SceneVersionOperation, 'read_reference' | 'generate'>;
  /** Texto da mensagem do cliente que o chat mostra. */
  content: string;
  attachments?: Array<{ assetId: string; name?: string }>;
  metrics: SceneVersionMetrics;
  /** A face 0 e a versão atual dela (a repetição, D-4, parte da atual). */
  face: { index: number; key: FaceKey; currentVersionId: string | null };
  userId: string | null;
  /** Para o upload: o id da versão já é conhecido (o arquivo mora na pasta dela). */
  versionId?: string;
  /** Roda com o id da mensagem, antes de a `revision` subir (a geração abre os itens do brief nela). */
  onMessage?: (messageId: string) => void;
}

/**
 * A versão `queued` da referência (leitura ou geração), a mensagem do cliente e o job `template_scene.turn` na mesma
 * transação, sem passar pelo Diretor. Quem chama já conferiu revisão, cena ocupada e a regra própria da rota.
 */
export async function enqueueReferenceTurn(
  manager: EntityManager,
  deps: { scene: TemplateScene; queue: AnimationQueueService },
  input: ReferenceTurnInput,
): Promise<ReferenceTurnResult> {
  const { scene, queue } = deps;
  const version = await manager.save(
    manager.create(TemplateSceneVersion, {
      ...(input.versionId ? { id: input.versionId } : {}),
      sceneId: scene.id,
      faceIndex: input.face.index,
      parentVersionId: input.operation === 'generate' ? input.face.currentVersionId : null,
      number: await nextVersionNumber(manager, scene.id),
      operation: input.operation,
      status: 'queued',
      step: null,
      elements: [],
      metrics: input.metrics,
      correlationId: randomUUID(),
      createdByUserId: input.userId,
    }),
  );
  const message = await manager.save(
    manager.create(TemplateSceneMessage, {
      sceneId: scene.id,
      versionId: version.id,
      faceIndex: input.face.index,
      role: 'user',
      content: input.content,
      attachments: input.attachments ?? [],
      status: 'queued',
      createdByUserId: input.userId,
    }),
  );
  input.onMessage?.(message.id);
  const jobId = await queue.publish(
    QUEUES.TEMPLATE_SCENE_TURN,
    { sceneId: scene.id, versionId: version.id, kind: input.operation },
    { manager, expireInSeconds: TURN_EXPIRE_SECONDS, retryLimit: 0 },
  );
  if (!jobId) throw new Error('A fila não aceitou o job da referência');
  const revision = await bumpRevision(manager, scene);
  await publishQueued(manager, {
    sceneId: scene.id,
    versionId: version.id,
    faceKey: input.face.key,
    revision,
    step: null,
  });
  return { messageId: message.id, versionId: version.id, jobId, revision };
}
