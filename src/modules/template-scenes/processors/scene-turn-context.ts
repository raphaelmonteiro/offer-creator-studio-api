import { EntityManager, In } from 'typeorm';
import {
  MaskShape,
  Rect,
  SceneElement,
  SceneVersionOperation,
  SceneZones,
} from '../domain/scene.types';
import { FaceKey, hasTwoFaces, SceneLayout } from '../domain/scene-faces';
import { openItems, turnItems } from '../domain/scene-brief';
import { DirectorPlan } from '../domain/scene-director-schema';
import { PaintedLine } from '../domain/scene-painted-text';
import { paintedLinesOf } from '../services/scene-director-blocks';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { currentVersionOf, loadFace } from '../services/scene-faces';
import { loadTurnReference, TurnReference } from './scene-turn-reference';

/** A versão de onde o turno parte: imagem em disco e camadas. */
export interface TurnParent {
  versionId: string;
  elements: SceneElement[];
  masterAssetId: string | null;
  previewAssetId: string | null;
  /** `null` quando a master foi apagada pelo GC (ou nunca existiu). */
  masterUrl: string | null;
  /** Linhas pintadas a pedido na versão (`metrics.paintedText`), com zona, que o redesenho confere de novo (D-56). */
  paintedText: PaintedLine[];
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
  /** Face do turno: as zonas, a versão de origem e a versão atual a trocar são as dela. */
  layout: SceneLayout;
  faceIndex: number;
  faceKey: FaceKey;
  /** Zonas da face (a frente não tem rodapé e o verso não tem cabeçalho; zona de altura 0 vale como miolo, PV-9). */
  zones: SceneZones;
  /** Jornal: a edição que só muda a altura do cabeçalho (D-1) traz a altura de antes e a nova, em cm; senão `null`. */
  headerResize: { fromCm: number; toCm: number } | null;
  artWidthCm: number;
  artHeightCm: number;
  widthPx: number;
  heightPx: number;
  request: string;
  /** A mensagem do cliente deste turno: os itens abertos com esta origem e não feitos têm pergunta própria (D-54). */
  messageId: string;
  /** Todas as mensagens do cliente na cena: a frase de continuidade sai se alguma pede moldura, faixa ou divisão. */
  clientMessages: string[];
  formatId: string;
  operation: SceneVersionOperation;
  /** O plano do Diretor, gravado em `metrics.plan` antes da janela; `null` em versão sem plano (job antigo). */
  plan: DirectorPlan | null;
  requestedRegion: Rect | null;
  requestedMask: MaskShape | null;
  targetElementId: string | null;
  parent: TurnParent | null;
  /** Logos anexadas à mensagem, ainda em disco: as camadas do plano com imagem usam (defeito b). */
  attachments: TurnAttachmentAsset[];
  /**
   * Itens em aberto no momento da chamada: os do turno e o que sobrou do turno anterior (os mais velhos já ficaram
   * superados ao fim dos turnos). A frase de pedidos em aberto da imagem nova usa esta lista.
   */
  openItems: Array<{ id: string; text: string; sourceMessageId?: string }>;
  /** Só os itens do turno (D-59): o juiz recebe e cobra estes, nunca o item de turno anterior nem o feito. */
  turnItems: Array<{ id: string; text: string }>;
  /** O encarte de referência: na leitura (`read_reference`) e na geração nascida da ficha; `null` nas outras (change add-template-scene-from-reference). */
  reference?: TurnReference | null;
}

const headerResizeOf = (version: TemplateSceneVersion): TurnContext['headerResize'] =>
  (version.metrics.headerResize as TurnContext['headerResize'] | undefined) ?? null;

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
  const face = await loadFace(manager, scene.id, version.faceIndex);
  // Só a cena de frente e verso separa os pedidos em aberto por face (PV-8).
  const itemFace = hasTwoFaces(scene.layout) ? face.key : undefined;
  return {
    sceneId: scene.id,
    versionId: version.id,
    correlationId: version.correlationId,
    layout: scene.layout,
    faceIndex: face.index,
    faceKey: face.key,
    // A versão do jornal que muda a altura do cabeçalho traz as zonas dela (PV-T10); senão valem as da face.
    zones: version.zones ?? face.zones,
    headerResize: headerResizeOf(version),
    artWidthCm: scene.artWidthCm,
    artHeightCm: scene.artHeightCm,
    widthPx: face.widthPx,
    heightPx: face.heightPx,
    request: message?.content ?? '',
    messageId: message?.id ?? '',
    clientMessages: (
      await manager.find(TemplateSceneMessage, {
        where: { sceneId: scene.id, role: 'user' },
        select: { content: true, createdAt: true },
        order: { createdAt: 'ASC' },
      })
    ).map((row) => row.content),
    formatId: scene.formatId,
    operation: version.operation,
    plan,
    requestedRegion: version.requestedRegion,
    requestedMask: version.requestedMask,
    targetElementId: version.targetElementId,
    parent: await loadParent(manager, version, face),
    attachments: await loadAttachments(manager, scene.id, message),
    openItems: openItems(scene.brief ?? [], itemFace).map((item) => ({
      id: item.id,
      text: item.text,
      sourceMessageId: item.sourceMessageId,
    })),
    turnItems: turnItems(scene.brief ?? [], message?.id ?? '').map((item) => ({
      id: item.id,
      text: item.text,
    })),
    reference: await loadTurnReference(manager, version),
  };
}

/**
 * A versão de onde o turno parte: a atual da face; na derivação do verso, a versão da frente que serviu de referência
 * (`derivedFromVersionId`), que não é a do verso (o verso nasce vazio).
 */
async function loadParent(
  manager: EntityManager,
  version: TemplateSceneVersion,
  face: TemplateSceneFace,
): Promise<TurnParent | null> {
  const parent =
    version.operation === 'derive_face' && version.derivedFromVersionId
      ? await manager.findOne(TemplateSceneVersion, { where: { id: version.derivedFromVersionId } })
      : await currentVersionOf(manager, face);
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
    paintedText: paintedLinesOf(parent),
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
