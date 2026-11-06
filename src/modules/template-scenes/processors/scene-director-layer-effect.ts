import { layerOpsToActions } from '../domain/scene-director-layers';
import { DirectorLayerOp } from '../domain/scene-director-schema';
import { sceneZonesFor } from '../domain/scene-formats';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { layerReply } from '../scene-texts';
import { bumpRevision } from '../services/scene-lock.service';
import { addAssistantMessage, settleUserMessage } from '../services/scene-messages';
import { pruneSceneAssets } from '../services/scene-retention';
import { DirectorTarget, rejectTarget } from './scene-director-target';
import { applyLayerActions } from './scene-layer-actions';
import { loadAttachments } from './scene-turn-context';
import { emitVersionEvent } from './scene-turn-finish';

/**
 * Camadas pelo chat (logo e texto exatos) sem chamar o modelo de imagem e sem fila: a versão de leitura vira
 * `ready` com a master da atual e as camadas novas, sob o lock. Alvo ausente ou ambíguo termina `rejected`.
 */
export async function applyLayersEffect(
  target: DirectorTarget,
  ops: DirectorLayerOp[],
): Promise<void> {
  const { manager, scene, version } = target;
  const current = await manager.findOneByOrFail(TemplateSceneVersion, {
    id: scene.currentVersionId as string,
  });
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
  const result = applyLayerActions(converted.actions, {
    zones: sceneZonesFor(scene.formatId),
    widthPx: scene.widthPx,
    heightPx: scene.heightPx,
    elements: current.elements,
    attachments,
  });
  if (result.ok === false) return rejectTarget(target, result.reply);
  Object.assign(version, {
    operation: 'set_layer' as const,
    status: 'ready' as const,
    step: 'done' as const,
    parentVersionId: current.id,
    masterAssetId: current.masterAssetId,
    previewAssetId: current.previewAssetId,
    elements: result.elements,
    metrics: { ...version.metrics, layer: { changed: result.changed } },
  });
  await manager.save(version);
  scene.currentVersionId = version.id;
  await pruneSceneAssets(manager, scene);
  await settleUserMessage(manager, version.id, 'done');
  await addAssistantMessage(manager, {
    sceneId: scene.id,
    versionId: version.id,
    content: layerReply(result.changed),
    status: 'done',
  });
  await bumpRevision(manager, scene);
  await emitVersionEvent(manager, scene, version, 'version.ready');
}
