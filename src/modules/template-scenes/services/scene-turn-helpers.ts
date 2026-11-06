import { EntityManager, QueryFailedError } from 'typeorm';
import { SceneStep } from '../domain/scene.types';
import { SendMessageDto } from '../dto/send-message.dto';
import { publishSceneEvent } from './scene-events';

const BUSY_INDEX = 'UQ_tsv_scene_busy';

/** Evento `version.step` da versão recém-enfileirada (`reading` no POST; `null` quando o anúncio e a janela estão gravados). */
export function publishQueued(
  manager: EntityManager,
  event: { sceneId: string; versionId: string; revision: number; step: SceneStep | null },
): Promise<void> {
  const { sceneId, versionId, revision, step } = event;
  return publishSceneEvent(manager, {
    sceneId,
    versionId,
    kind: 'version.step',
    step,
    status: 'queued',
    cancelRequested: false,
    costUsd: 0,
    revision,
  });
}

/** A mensagem recebida e quem a enviou. */
export interface TurnInput {
  dto: SendMessageDto;
  userId: string | null;
}

/** O índice parcial `UQ_tsv_scene_busy` é a rede de segurança de D-3: a violação também é SCENE_BUSY. */
export function isBusyIndexViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driver = error.driverError as { code?: string; constraint?: string } | undefined;
  return driver?.code === '23505' && driver.constraint === BUSY_INDEX;
}
