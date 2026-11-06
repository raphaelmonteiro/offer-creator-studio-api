import { EntityManager } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TurnDecision } from '../domain/scene-director-decision';
import { DirectorPlan } from '../domain/scene-director-schema';
import { MARKING_DISCARDED_NOTE, REDRAW_NOTICE } from '../scene-texts';
import { bumpRevision } from '../services/scene-lock.service';
import { addAssistantMessage } from '../services/scene-messages';
import { publishQueued } from '../services/scene-turn-helpers';
import { TURN_EXPIRE_SECONDS } from '../services/scene-turn.service';
import { DirectorTarget } from './scene-director-target';

/** Já houve aviso do redesenho nesta cena? É fato do banco: alguma versão com `metrics.notice = true`. */
async function alreadyNotified(manager: EntityManager, sceneId: string): Promise<boolean> {
  const rows: unknown[] = await manager.query(
    `SELECT 1 FROM template_scene_versions WHERE "sceneId" = $1 AND metrics->>'notice' = 'true' LIMIT 1`,
    [sceneId],
  );
  return rows.length > 0;
}

/** Grava o anúncio e o plano e publica o job de imagem, com `startAfterSeconds` quando há janela. */
export async function queueImageEffect(
  target: DirectorTarget,
  decision: Extract<TurnDecision, { kind: 'image' }>,
  deps: { queue: AnimationQueueService; windowSeconds: number },
): Promise<void> {
  const { manager, scene, version } = target;
  const windowSeconds = decision.window ? deps.windowSeconds : 0;
  version.operation = decision.operation;
  version.step = null;
  if (decision.planPatch) {
    // O Diretor não deu a instrução do "marquei": o plano gravado (e o prompt) passam a ter a dos pedidos em aberto.
    version.metrics = {
      ...version.metrics,
      plan: { ...(version.metrics.plan as DirectorPlan), ...decision.planPatch },
      planPatched: true,
    };
  }
  if (decision.window) {
    version.metrics = {
      ...version.metrics,
      windowEndsAt: new Date(Date.now() + windowSeconds * 1000).toISOString(),
    };
  }
  if (decision.discardMarking) {
    version.requestedRegion = null;
    version.requestedMask = null;
  }
  await manager.save(scene);
  const notes: string[] = [];
  if (decision.discardMarking) notes.push(MARKING_DISCARDED_NOTE);
  if (decision.isEdit && !(await alreadyNotified(manager, scene.id))) {
    // D-35: o aviso fica gravado com a versão do anúncio, antes da janela, então "Parar" não o repete.
    notes.push(REDRAW_NOTICE);
    version.metrics = { ...version.metrics, notice: true };
  }
  await manager.save(version);
  await addAssistantMessage(manager, {
    sceneId: scene.id,
    versionId: version.id,
    content: [decision.announcement, ...notes].join(' '),
    status: 'done',
  });
  const jobId = await deps.queue.publish(
    QUEUES.TEMPLATE_SCENE_TURN,
    { sceneId: scene.id, versionId: version.id },
    {
      manager,
      expireInSeconds: TURN_EXPIRE_SECONDS + windowSeconds,
      retryLimit: 0,
      ...(windowSeconds > 0 ? { startAfterSeconds: windowSeconds } : {}),
    },
  );
  if (!jobId) throw new Error('A fila não aceitou o job de imagem da cena');
  const revision = await bumpRevision(manager, scene);
  await publishQueued(manager, { sceneId: scene.id, versionId: version.id, revision, step: null });
}
