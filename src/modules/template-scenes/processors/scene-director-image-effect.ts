import { EntityManager } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TurnDecision } from '../domain/scene-director-decision';
import { DirectorPlan } from '../domain/scene-director-schema';
import { MARKING_DISCARDED_NOTE, PAINTED_LAYER_NOTE, REDRAW_NOTICE } from '../scene-texts';
import { fold } from '../../../shared/text/fold';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { faceKeyOfVersion, loadFace } from '../services/scene-faces';
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

/** A frase pintada nesta rodada é igual a uma camada de texto da versão atual (D-55)? A camada sai com a imagem. */
async function paintsExistingLayer(
  manager: EntityManager,
  currentId: string | null,
  plan: DirectorPlan,
): Promise<boolean> {
  const lines = (plan.image?.exact_text ?? []).map((line) => fold(line.trim()));
  if (!currentId || lines.length === 0) return false;
  const current = await manager.findOne(TemplateSceneVersion, { where: { id: currentId } });
  return (current?.elements ?? []).some(
    (element) => element.kind === 'text' && lines.includes(fold((element.text ?? '').trim())),
  );
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
  if (decision.zones) {
    // D-1, PV-T10: a altura nova vale para a imagem desta versão; a face só a adota quando a versão fica pronta.
    version.zones = decision.zones;
    if (decision.headerResize) {
      version.metrics = { ...version.metrics, headerResize: decision.headerResize };
    }
  }
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
  if (decision.discardMarking) notes.push(decision.markingNote ?? MARKING_DISCARDED_NOTE);
  const face = await loadFace(manager, scene.id, version.faceIndex);
  if (
    await paintsExistingLayer(manager, face.currentVersionId, version.metrics.plan as DirectorPlan)
  ) {
    notes.push(PAINTED_LAYER_NOTE);
  }
  if (decision.isEdit && !(await alreadyNotified(manager, scene.id))) {
    // D-35: o aviso fica gravado com a versão do anúncio, antes da janela, então "Parar" não o repete.
    notes.push(REDRAW_NOTICE);
    version.metrics = { ...version.metrics, notice: true };
  }
  await announceAndQueue(target, {
    content: [decision.announcement, ...notes].join(' '),
    windowSeconds,
    queue: deps.queue,
  });
}

/**
 * O fim comum dos turnos que chamam a imagem: grava a versão e o anúncio, publica o job (com `startAfterSeconds`
 * quando há janela), sobe a `revision` e avisa que a versão está na fila.
 */
export async function announceAndQueue(
  target: DirectorTarget,
  input: { content: string; windowSeconds: number; queue: AnimationQueueService },
): Promise<void> {
  const { manager, scene, version } = target;
  const { content, windowSeconds } = input;
  await manager.save(version);
  await addAssistantMessage(manager, {
    sceneId: scene.id,
    versionId: version.id,
    content,
    status: 'done',
  });
  const jobId = await input.queue.publish(
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
  await publishQueued(manager, {
    sceneId: scene.id,
    versionId: version.id,
    faceKey: faceKeyOfVersion(scene, version),
    revision,
    step: null,
  });
}
