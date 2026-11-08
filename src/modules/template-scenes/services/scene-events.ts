import { EntityManager } from 'typeorm';
import { TEMPLATE_SCENE_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { QUEUES, QueuePort } from '../../../shared/queue/animation-queue.service';
import { FaceKey } from '../domain/scene-faces';
import { SceneStep, SceneVersionStatus } from '../domain/scene.types';

export type SceneEventKind =
  | 'version.step'
  | 'version.ready'
  | 'version.failed'
  | 'version.cancelled';

/** Payload do canal `template_scene_events`: o front refaz o `GET /:id` a cada evento. */
export interface SceneEvent {
  sceneId: string;
  versionId: string;
  /** Face da versão (`single`, `front` ou `back`): a tela troca de aba quando o verso é derivado pelo chat. */
  faceKey: FaceKey;
  kind: SceneEventKind;
  step: SceneStep | null;
  status: SceneVersionStatus;
  cancelRequested: boolean;
  costUsd: number;
  /** `revision` da cena depois da mutação: o front descarta evento mais velho que o estado carregado. */
  revision: number;
  at: string;
}

/**
 * Publica o evento na MESMA transação da mudança (o `pg_notify` só sai no COMMIT, então o cliente
 * nunca recebe um evento de algo que foi desfeito).
 */
export async function publishSceneEvent(
  manager: EntityManager,
  event: Omit<SceneEvent, 'at'>,
): Promise<void> {
  const payload: SceneEvent = { ...event, at: new Date().toISOString() };
  await manager.query('SELECT pg_notify($1, $2)', [
    TEMPLATE_SCENE_EVENTS_CHANNEL,
    JSON.stringify(payload),
  ]);
}

/** Espera antes do job de sincronização: uma rajada de ajustes vira uma projeção só (PV-11). */
export const TEMPLATE_SYNC_DELAY_SECONDS = 5;
/** Retentativas do pg-boss: 3 tentativas ao todo, o mesmo teto de falhas da varredura (PV-15). */
export const TEMPLATE_SYNC_RETRY_LIMIT = 2;

/**
 * Enfileira, na MESMA transação, o job que mantém o template da cena (`template_scene.template_sync`). O job só
 * fica visível no COMMIT, e `singletonKey` = id da cena junta o que chegar enquanto ele espera. Quem já está
 * rodando não é afetado: o job lê o estado na hora em que roda (PV-13).
 */
export async function enqueueTemplateSync(
  queue: Pick<QueuePort, 'publish'>,
  manager: EntityManager,
  sceneId: string,
): Promise<void> {
  await queue.publish(
    QUEUES.TEMPLATE_SCENE_TEMPLATE_SYNC,
    { sceneId },
    {
      manager,
      singletonKey: sceneId,
      startAfterSeconds: TEMPLATE_SYNC_DELAY_SECONDS,
      retryLimit: TEMPLATE_SYNC_RETRY_LIMIT,
    },
  );
}

/**
 * Todo caminho que publica `version.ready` passa por aqui: o evento e o job do template saem juntos, na mesma
 * transação, e um caminho novo não esquece o job (PV-11).
 */
export async function publishVersionReady(
  manager: EntityManager,
  queue: Pick<QueuePort, 'publish'>,
  event: Omit<SceneEvent, 'at' | 'kind'>,
): Promise<void> {
  await publishSceneEvent(manager, { ...event, kind: 'version.ready' });
  await enqueueTemplateSync(queue, manager, event.sceneId);
}
