import { EntityManager, In, IsNull } from 'typeorm';
import {
  MaskShape,
  Rect,
  SceneElement,
  SceneVersionOperation,
  SceneZones,
} from '../domain/scene.types';
import { sceneZonesFor } from '../domain/scene-formats';
import { SceneClassification } from '../domain/scene-operation.classifier';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';

/** A versão de onde o turno parte: imagem em disco e camadas. */
export interface TurnParent {
  versionId: string;
  elements: SceneElement[];
  masterAssetId: string | null;
  previewAssetId: string | null;
  /** `null` quando a master foi apagada pelo GC (ou nunca existiu). */
  masterUrl: string | null;
}

/** Logo (ou outra imagem) anexada à mensagem. */
export interface TurnAttachmentAsset {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
}

/** O que o processor precisa saber da versão para trabalhar sem segurar lock durante a chamada paga. */
export interface TurnContext {
  sceneId: string;
  versionId: string;
  correlationId: string;
  zones: SceneZones;
  artWidthCm: number;
  artHeightCm: number;
  widthPx: number;
  heightPx: number;
  request: string;
  formatId: string;
  operation: SceneVersionOperation;
  /** Classificação gravada ao enfileirar; `null` na geração simples (versões antigas). */
  plan: SceneClassification | null;
  requestedRegion: Rect | null;
  requestedMask: MaskShape | null;
  targetElementId: string | null;
  parent: TurnParent | null;
  attachmentAssets: TurnAttachmentAsset[];
  /** Pedido efetivo da geração `ready` mais recente (o tema que "gere outra imagem" não repete); só na imagem nova. */
  originalRequest: string | null;
}

/** Monta o contexto do turno a partir da versão `queued` (leitura sob o lock da cena). */
export async function loadTurnContext(
  manager: EntityManager,
  scene: TemplateScene,
  version: TemplateSceneVersion,
): Promise<TurnContext> {
  const message = await manager.findOne(TemplateSceneMessage, {
    where: { versionId: version.id, role: 'user' },
    order: { createdAt: 'ASC' },
  });
  const plan = (version.metrics.plan as SceneClassification | undefined) ?? null;
  return {
    sceneId: scene.id,
    versionId: version.id,
    correlationId: version.correlationId,
    zones: sceneZonesFor(scene.formatId),
    artWidthCm: scene.artWidthCm,
    artHeightCm: scene.artHeightCm,
    widthPx: scene.widthPx,
    heightPx: scene.heightPx,
    request: message?.content ?? '',
    formatId: scene.formatId,
    operation: version.operation,
    plan,
    requestedRegion: version.requestedRegion,
    requestedMask: version.requestedMask,
    targetElementId: version.targetElementId,
    parent: await loadParent(manager, scene),
    attachmentAssets: await loadAttachments(manager, scene.id, message),
    originalRequest:
      plan?.operation === 'new_image' ? await loadOriginalRequest(manager, scene.id) : null,
  };
}

/**
 * Pedido efetivo da geração `ready` mais recente que o gravou (PV-33): `metrics.generationRequest`. O ajuste
 * geral também é `generate`, mas grava `globalInstruction`, então não conta (R39). Sem nenhuma (versões
 * antigas), cai na mensagem da primeira geração da cena, também `ready` (R30).
 */
async function loadOriginalRequest(
  manager: EntityManager,
  sceneId: string,
): Promise<string | null> {
  const generations = await manager.find(TemplateSceneVersion, {
    where: { sceneId, operation: 'generate', status: 'ready' },
    order: { number: 'DESC' },
  });
  const recorded = generations
    .map((version) => version.metrics.generationRequest)
    .find((value) => typeof value === 'string' && value.trim());
  if (typeof recorded === 'string' && recorded.trim()) return recorded;
  const first = await manager.findOne(TemplateSceneVersion, {
    where: { sceneId, operation: 'generate', parentVersionId: IsNull(), status: 'ready' },
    order: { number: 'ASC' },
  });
  if (!first) return null;
  const message = await manager.findOne(TemplateSceneMessage, {
    where: { versionId: first.id, role: 'user' },
    order: { createdAt: 'ASC' },
  });
  return message?.content ?? null;
}

async function loadParent(
  manager: EntityManager,
  scene: TemplateScene,
): Promise<TurnParent | null> {
  const parent = scene.currentVersionId
    ? await manager.findOne(TemplateSceneVersion, { where: { id: scene.currentVersionId } })
    : null;
  if (!parent) return null;
  const master = parent.masterAssetId
    ? await manager.findOne(TemplateSceneAsset, { where: { id: parent.masterAssetId } })
    : null;
  return {
    versionId: parent.id,
    elements: parent.elements,
    masterAssetId: parent.masterAssetId,
    previewAssetId: parent.previewAssetId,
    masterUrl: master && !master.purgedAt ? master.url : null,
  };
}

async function loadAttachments(
  manager: EntityManager,
  sceneId: string,
  message: TemplateSceneMessage | null,
): Promise<TurnAttachmentAsset[]> {
  const ids = (message?.attachments ?? []).map((attachment) => attachment.assetId);
  if (ids.length === 0) return [];
  const assets = await manager.findBy(TemplateSceneAsset, { sceneId, id: In(ids), role: 'logo' });
  return assets
    .filter((asset) => !asset.purgedAt)
    .map((a) => ({ id: a.id, url: a.url, width: a.width, height: a.height }));
}
