import { HttpException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { TurnDecision } from '../domain/scene-director-decision';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { BACK_EXISTS_REPLY, FRONT_FIRST_REPLY } from '../scene-texts';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { assertDerivable, FrontAndBack, loadFrontAndBack } from '../services/scene-derive-face';
import { announceAndQueue } from './scene-director-image-effect';
import { DirectorTarget, rejectTarget } from './scene-director-target';

/** A frente de onde derivar, ou a resposta ao cliente quando a conferência recusa (a frente sumiu ou o verso já nasceu). */
async function frontOrReply(
  manager: EntityManager,
  faces: FrontAndBack,
): Promise<TemplateSceneVersion | string> {
  try {
    return await assertDerivable(manager, faces);
  } catch (error) {
    const code =
      error instanceof HttpException ? (error.getResponse() as { code?: string }).code : '';
    if (code === 'FRONT_NOT_READY') return FRONT_FIRST_REPLY;
    if (code === 'BACK_ALREADY_EXISTS') return BACK_EXISTS_REPLY;
    throw error;
  }
}

/**
 * "Fazer o verso" pelo chat (PV-14): a versão de leitura vira a versão `derive_face` do verso (`faceIndex` passa a 1
 * antes da chamada, na mesma linha), derivada da versão atual da frente, e o job de imagem sai com a janela de
 * sempre. O contexto do Diretor foi lido antes da trava: as duas conferências do botão (frente pronta, verso vazio)
 * rodam de novo aqui, e o que mudou nesse meio-tempo termina `rejected` com a resposta, sem chamada paga.
 */
export async function applyDeriveEffect(
  target: DirectorTarget,
  decision: Extract<TurnDecision, { kind: 'derive' }>,
  deps: { queue: AnimationQueueService; windowSeconds: number },
): Promise<void> {
  const { manager, scene, version } = target;
  const faces = await loadFrontAndBack(manager, scene.id);
  const front = await frontOrReply(manager, faces);
  if (typeof front === 'string') return rejectTarget(target, front);
  const windowSeconds = decision.window ? deps.windowSeconds : 0;
  Object.assign(version, {
    operation: 'derive_face' as const,
    faceIndex: faces.back.index,
    parentVersionId: null,
    derivedFromVersionId: front.id,
    requestedRegion: null,
    requestedMask: null,
    targetElementId: null,
    step: null,
  });
  if (windowSeconds > 0) {
    version.metrics = {
      ...version.metrics,
      windowEndsAt: new Date(Date.now() + windowSeconds * 1000).toISOString(),
    };
  }
  // A mensagem que pediu o verso passa a ser do Verso: a conversa conta a história da face que ela mudou (PV-17).
  await manager.update(
    TemplateSceneMessage,
    { versionId: version.id, role: 'user' },
    { faceIndex: faces.back.index },
  );
  await manager.save(scene);
  await announceAndQueue(target, {
    content: decision.announcement,
    windowSeconds,
    queue: deps.queue,
  });
}
