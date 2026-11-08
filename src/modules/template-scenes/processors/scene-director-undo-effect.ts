import { QueuePort } from '../../../shared/queue/animation-queue.service';
import { versionRestoredReply } from '../scene-texts';
import { displayNumbersOf } from '../services/scene-display-number';
import { bumpRevision } from '../services/scene-lock.service';
import { addAssistantMessage, settleUserMessage } from '../services/scene-messages';
import { loadFace, setFaceCurrentVersion } from '../services/scene-faces';
import { restoreInto } from '../services/scene-restore';
import { pruneSceneAssets } from '../services/scene-retention';
import { closeTurnBrief } from '../services/scene-turn-brief';
import { resolveUndo } from '../services/scene-undo';
import { DirectorTarget, rejectTarget } from './scene-director-target';
import { emitVersionReady } from './scene-turn-finish';

/**
 * Desfazer sem chamar o modelo de imagem: a versão de leitura vira a restauração (sem segunda versão), sob o
 * mesmo lock. Sem como voltar, termina `rejected` com a resposta.
 */
export async function applyUndoEffect(
  target: DirectorTarget,
  undoTarget: 'previous' | number,
  deps: { queue: Pick<QueuePort, 'publish'> },
): Promise<void> {
  const { manager, scene, version } = target;
  const face = await loadFace(manager, scene.id, version.faceIndex);
  const resolution = await resolveUndo(manager, face, undoTarget);
  if (resolution.kind === 'reply') {
    await rejectTarget(target, resolution.reply);
    return;
  }
  await closeTurnBrief(manager, scene, version);
  await restoreInto(manager, scene, resolution.source, { reading: version });
  await setFaceCurrentVersion(manager, scene, version.faceIndex, version.id);
  await pruneSceneAssets(manager, scene);
  await settleUserMessage(manager, version.id, 'done');
  const shown = (await displayNumbersOf(manager, scene.id)).get(version.id) ?? 0;
  await addAssistantMessage(manager, {
    sceneId: scene.id,
    versionId: version.id,
    content: versionRestoredReply(resolution.sourceDisplayNumber, shown),
    status: 'done',
  });
  await bumpRevision(manager, scene);
  await emitVersionReady(manager, deps.queue, scene, version);
}
