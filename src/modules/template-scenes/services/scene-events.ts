import { EntityManager } from 'typeorm';
import { TEMPLATE_SCENE_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
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
