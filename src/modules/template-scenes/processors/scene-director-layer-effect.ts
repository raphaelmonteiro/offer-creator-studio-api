import { QueuePort } from '../../../shared/queue/animation-queue.service';
import { layerOpsToActions } from '../domain/scene-director-layers';
import { DirectorLayerOp } from '../domain/scene-director-schema';
import { describeLayerDiff, noLayerChangeText } from '../domain/scene-layer-diff';
import { LayerAction } from '../domain/scene-layer.types';
import { paintedMetricsOf } from '../domain/scene-painted-text';
import { SceneElement } from '../domain/scene.types';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { currentVersionOf, loadFace, setFaceCurrentVersion } from '../services/scene-faces';
import { bumpRevision } from '../services/scene-lock.service';
import { closeTurnBrief } from '../services/scene-turn-brief';
import { SceneFilesService } from '../services/scene-files.service';
import { readVersionMaster } from '../services/scene-master';
import { addAssistantMessage, settleUserMessage } from '../services/scene-messages';
import { pruneSceneAssets } from '../services/scene-retention';
import { DirectorTarget, rejectTarget } from './scene-director-target';
import { applyLayerActions } from './scene-layer-actions';
import { colorNewTexts } from './scene-layer-color';
import { loadAttachments } from './scene-turn-context';
import { emitVersionReady } from './scene-turn-finish';

/** A camada que o primeiro pedido mirava, para dizer "já está lá" quando nada mudou. */
function targetOfFirst(actions: LayerAction[], elements: SceneElement[]): SceneElement | null {
  const first = actions[0];
  if (!first || !('target' in first)) return null;
  const { target } = first;
  return (
    ('elementId' in target
      ? elements.find((element) => element.id === target.elementId)
      : elements.find((element) => element.kind === target.kind)) ?? null
  );
}

/**
 * A versão de leitura vira a de camada: master e prévia da atual, as camadas novas e o texto pintado da atual, porque
 * a master não muda (R66).
 */
async function saveLayerVersion(
  target: DirectorTarget,
  current: TemplateSceneVersion,
  input: { elements: SceneElement[]; changed: string[] },
): Promise<void> {
  const { manager, scene, version } = target;
  await closeTurnBrief(manager, scene, version);
  Object.assign(version, {
    operation: 'set_layer' as const,
    status: 'ready' as const,
    step: 'done' as const,
    parentVersionId: current.id,
    masterAssetId: current.masterAssetId,
    previewAssetId: current.previewAssetId,
    elements: input.elements,
    // A master não muda: a altura do cabeçalho da atual segue valendo (PV-T10).
    zones: current.zones,
    metrics: {
      ...version.metrics,
      layer: { changed: input.changed },
      ...paintedMetricsOf(current),
    },
  });
  await manager.save(version);
}

/** A versão de camada vira a atual, e o chat diz o que mudou (sob o lock da cena). */
async function finishLayerTurn(
  target: DirectorTarget,
  content: string,
  queue: Pick<QueuePort, 'publish'>,
): Promise<void> {
  const { manager, scene, version } = target;
  await setFaceCurrentVersion(manager, scene, version.faceIndex, version.id);
  await pruneSceneAssets(manager, scene);
  await settleUserMessage(manager, version.id, 'done');
  await addAssistantMessage(manager, {
    sceneId: scene.id,
    versionId: version.id,
    content,
    status: 'done',
  });
  await bumpRevision(manager, scene);
  await emitVersionReady(manager, queue, scene, version);
}

/**
 * Camadas pelo chat (logo e texto exatos) sem chamar o modelo de imagem e sem fila: a versão de leitura vira
 * `ready` com a master da atual e as camadas novas, sob o lock. Alvo ausente ou ambíguo termina `rejected`. A
 * resposta vem da diferença entre as camadas antes e depois (D-51): sem diferença, nenhuma versão nasce e o chat diz
 * que nada mudou.
 */
export async function applyLayersEffect(
  target: DirectorTarget,
  ops: DirectorLayerOp[],
  deps: { files: SceneFilesService; queue: Pick<QueuePort, 'publish'> },
): Promise<void> {
  const { manager, scene, version } = target;
  const face = await loadFace(manager, scene.id, version.faceIndex);
  const current = (await currentVersionOf(manager, face)) as TemplateSceneVersion;
  const message = await manager.findOne(TemplateSceneMessage, {
    where: { versionId: version.id, role: 'user' },
    order: { createdAt: 'ASC' },
  });
  const attachments = await loadAttachments(manager, scene.id, message);
  const converted = layerOpsToActions(ops, {
    elements: current.elements,
    attachmentId: attachments[0]?.id ?? null,
    hintElementId: version.targetElementId,
  });
  if (converted.ok === false) return rejectTarget(target, converted.reply);
  const { zones } = face;
  const result = applyLayerActions(converted.actions, {
    zones,
    widthPx: scene.widthPx,
    heightPx: scene.heightPx,
    elements: current.elements,
    attachments,
  });
  if (result.ok === false) return rejectTarget(target, result.reply);
  const master = await readVersionMaster(manager, deps.files, current);
  const elements = master
    ? await colorNewTexts(current.elements, result.elements, {
        master,
        widthPx: scene.widthPx,
        heightPx: scene.heightPx,
      })
    : result.elements;
  const diff = describeLayerDiff(current.elements, elements, zones);
  if (!diff.changed) {
    const where = targetOfFirst(converted.actions, current.elements);
    return rejectTarget(target, noLayerChangeText(where, zones));
  }
  await saveLayerVersion(target, current, { elements, changed: result.changed });
  await finishLayerTurn(target, diff.text as string, deps.queue);
}
