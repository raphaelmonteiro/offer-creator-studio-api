import { EntityManager, In } from 'typeorm';
import {
  MaskShape,
  Rect,
  SceneElement,
  SceneVersionOperation,
  SceneZones,
} from '../domain/scene.types';
import { sceneZonesFor } from '../domain/scene-formats';
import { openItems } from '../domain/scene-brief';
import { DirectorPlan } from '../domain/scene-director-schema';
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
  /** O plano do Diretor, gravado em `metrics.plan` antes da janela; `null` em versão sem plano (job antigo). */
  plan: DirectorPlan | null;
  requestedRegion: Rect | null;
  requestedMask: MaskShape | null;
  targetElementId: string | null;
  parent: TurnParent | null;
  /** Textos dos itens em aberto da lista do que o cliente pediu, no momento da chamada (o juiz os confere depois). */
  openItems: Array<{ id: string; text: string }>;
  /** Itens já dados como feitos (os mais recentes): o juiz confere se ainda aparecem depois do redesenho. */
  doneItems: Array<{ id: string; text: string }>;
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
  const plan = (version.metrics.plan as DirectorPlan | undefined) ?? null;
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
    openItems: openItems(scene.brief ?? []).map((item) => ({ id: item.id, text: item.text })),
    doneItems: (scene.brief ?? [])
      .filter((item) => item.status === 'done')
      .slice(-10)
      .map((item) => ({ id: item.id, text: item.text })),
  };
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

/** Logos anexadas à mensagem, ainda em disco (as camadas pelo chat usam). */
export async function loadAttachments(
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
