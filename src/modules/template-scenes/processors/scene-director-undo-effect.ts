import { versionRestoredReply } from '../scene-texts';
import { displayNumbersOf } from '../services/scene-display-number';
import { bumpRevision } from '../services/scene-lock.service';
import { addAssistantMessage, settleUserMessage } from '../services/scene-messages';
import { restoreInto } from '../services/scene-restore';
import { pruneSceneAssets } from '../services/scene-retention';
import { closeTurnBrief } from '../services/scene-turn-brief';
import { resolveUndo } from '../services/scene-undo';
import { DirectorTarget, rejectTarget } from './scene-director-target';
import { emitVersionEvent } from './scene-turn-finish';

/**
 * Desfazer sem chamar o modelo de imagem: a versão de leitura vira a restauração (sem segunda versão), sob o
 * mesmo lock. Sem como voltar, termina `rejected` com a resposta.
 */
export async function applyUndoEffect(
  target: DirectorTarget,
  undoTarget: 'previous' | number,
): Promise<void> {
  const { manager, scene, version } = target;
  const resolution = await resolveUndo(manager, scene, undoTarget);
  if (resolution.kind === 'reply') {
    await rejectTarget(target, resolution.reply);
    return;
  }
  await closeTurnBrief(manager, scene, version);
  await restoreInto(manager, scene, resolution.source, { reading: version });
  scene.currentVersionId = version.id;
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
  await emitVersionEvent(manager, scene, version, 'version.ready');
}
