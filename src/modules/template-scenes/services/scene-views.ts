import {
  MaskShape,
  Rect,
  SceneElement,
  SceneFailureCode,
  SceneAssetRole,
  SceneMessageRole,
  SceneMessageStatus,
  SceneStep,
  SceneVersionOperation,
  SceneVersionStatus,
  SceneZones,
} from '../domain/scene.types';
import { SceneClassification } from '../domain/scene-operation.classifier';
import { SceneTargetSource, targetSourceOf } from '../domain/scene-target-source';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';

/** Saída da API: nunca se devolve entidade do ORM. */

export interface SceneAssetView {
  id: string;
  role: SceneAssetRole;
  url: string;
  width: number | null;
  height: number | null;
}

export type RestorableReason = 'not_ready' | 'master_purged';

/** Métricas públicas de uma edição (o que o front mostra: chip "preservou X%" e o aviso de sem mudança). */
export interface SceneMetricsView {
  insideMaskDiffRatio: number | null;
  /** `null` sem pixels na faixa da margem (o chip não aparece). */
  marginDiffRatio: number | null;
  seamSsim: number | null;
  maskAreaRatio: number | null;
  /** O modelo devolveu praticamente a mesma área (a versão fica `ready` com aviso). */
  noChange: boolean;
  /** A visão disse que o pedido não foi atendido: a versão não virou a atual (D-18/correção 3). */
  notApplied: boolean;
  /** Resultado da visão antes/depois; `null` quando ela não rodou ou falhou. */
  vision: { satisfied: 'sim' | 'parcial' | 'nao' } | null;
}

export interface SceneVersionView {
  id: string;
  number: number;
  operation: SceneVersionOperation;
  status: SceneVersionStatus;
  step: SceneStep | null;
  parentVersionId: string | null;
  cancelRequestedAt: string | null;
  cancelRequested: boolean;
  errorCode: SceneFailureCode | null;
  providerCostUsd: number;
  latencyMs: number | null;
  isOpenManual: boolean;
  approvedAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Derivado: `ready` com a master ainda em disco (`purgedAt` nulo). */
  restorable: boolean;
  restorableReason: RestorableReason | null;
  /** Nulo quando a prévia foi apagada ou a versão não tem imagem. */
  previewUrl: string | null;
  /** Área alterada (retângulo, zona ou caixa da forma), para o destaque de 2 s na prévia. */
  requestedRegion: Rect | null;
  requestedMask: MaskShape | null;
  targetElementId: string | null;
  /** De onde veio a área entendida; o chip "região marcada" só aparece em `marked`, `zone_field` e `element`. */
  targetSource: SceneTargetSource | null;
  /** Imagem nova do zero (D-18): o painel mostra "Imagem nova" em vez de "Ajuste geral". */
  isNewImage: boolean;
  /** Só nas edições locais; `null` nas demais versões. */
  metrics: SceneMetricsView | null;
}

export interface SceneCurrentVersionView extends SceneVersionView {
  elements: SceneElement[];
  master: SceneAssetView | null;
  preview: SceneAssetView | null;
  /** Master, prévia e imagens usadas pelos elementos, para o front resolver `assetId`. */
  assets: SceneAssetView[];
}

export interface SceneMessageView {
  id: string;
  role: SceneMessageRole;
  content: string;
  attachments: Array<{ assetId: string; name?: string }>;
  status: SceneMessageStatus;
  versionId: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface SceneSummaryView {
  id: string;
  name: string;
  formatId: string;
  artWidthCm: number;
  artHeightCm: number;
  widthPx: number;
  heightPx: number;
  pixelsPerCm: number;
  revision: number;
  totalCostUsd: number;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SceneDetailView extends SceneSummaryView {
  zones: SceneZones;
  currentVersion: SceneCurrentVersionView | null;
  /** Versão `queued`/`running`, para a tela mostrar etapa e "Cancelar" depois de recarregar. */
  activeVersion: SceneVersionView | null;
  messages: SceneMessageView[];
  versions: {
    items: SceneVersionView[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface SceneListItemView {
  id: string;
  name: string;
  formatId: string;
  previewUrl: string | null;
  updatedAt: string;
  totalCostUsd: number;
  createdByUserId: string | null;
  createdByName: string | null;
}

/** Restaurável = `ready` e master ainda em disco; sem marca por versão (decisão do dono, achado 5). */
export function restorableState(
  version: Pick<TemplateSceneVersion, 'status' | 'masterAssetId'>,
  master: Pick<TemplateSceneAsset, 'purgedAt'> | undefined,
): { restorable: boolean; reason: RestorableReason | null } {
  if (version.status !== 'ready' || !version.masterAssetId) {
    return { restorable: false, reason: 'not_ready' };
  }
  if (!master || master.purgedAt) return { restorable: false, reason: 'master_purged' };
  return { restorable: true, reason: null };
}

const isNewImage = (version: Pick<TemplateSceneVersion, 'metrics'>): boolean =>
  (version.metrics?.plan as { turn_kind?: string } | undefined)?.turn_kind === 'imagem_nova';

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Só as métricas de edição que o front usa; `calls`, `plan` e diagnósticos ficam no servidor. */
export function toMetricsView(
  version: Pick<TemplateSceneVersion, 'metrics'>,
): SceneMetricsView | null {
  const m = version.metrics ?? {};
  // O ajuste geral não grava `noChange`: ele só tem métricas quando não foi aplicado.
  if (typeof m.noChange !== 'boolean' && m.notApplied !== true) return null;
  const vision = m.vision as { satisfied?: 'sim' | 'parcial' | 'nao' } | null | undefined;
  return {
    insideMaskDiffRatio: numberOrNull(m.insideMaskDiffRatio),
    marginDiffRatio: numberOrNull(m.marginDiffRatio),
    seamSsim: numberOrNull(m.seamSsim),
    maskAreaRatio: numberOrNull(m.maskAreaRatio),
    noChange: m.noChange === true,
    notApplied: m.notApplied === true,
    vision: vision?.satisfied ? { satisfied: vision.satisfied } : null,
  };
}

export function toAssetView(asset: TemplateSceneAsset): SceneAssetView {
  return {
    id: asset.id,
    role: asset.role,
    url: asset.url,
    width: asset.width,
    height: asset.height,
  };
}

export function toVersionView(
  version: TemplateSceneVersion,
  assets: ReadonlyMap<string, TemplateSceneAsset>,
): SceneVersionView {
  const master = version.masterAssetId ? assets.get(version.masterAssetId) : undefined;
  const preview = version.previewAssetId ? assets.get(version.previewAssetId) : undefined;
  const state = restorableState(version, master);
  return {
    id: version.id,
    number: version.number,
    operation: version.operation,
    status: version.status,
    step: version.step,
    parentVersionId: version.parentVersionId,
    cancelRequestedAt: iso(version.cancelRequestedAt),
    cancelRequested: version.cancelRequestedAt !== null,
    errorCode: version.errorCode,
    providerCostUsd: version.providerCostUsd,
    latencyMs: version.latencyMs,
    isOpenManual: version.isOpenManual,
    approvedAt: iso(version.approvedAt),
    createdByUserId: version.createdByUserId,
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
    restorable: state.restorable,
    restorableReason: state.reason,
    previewUrl: preview && !preview.purgedAt ? preview.url : null,
    requestedRegion: version.requestedRegion,
    requestedMask: version.requestedMask,
    targetElementId: version.targetElementId,
    targetSource: targetSourceOf(version.metrics?.plan as SceneClassification | undefined),
    isNewImage: isNewImage(version),
    metrics: toMetricsView(version),
  };
}

export function toCurrentVersionView(
  version: TemplateSceneVersion,
  assets: ReadonlyMap<string, TemplateSceneAsset>,
): SceneCurrentVersionView {
  const base = toVersionView(version, assets);
  const live = (id: string | null) => {
    const asset = id ? assets.get(id) : undefined;
    return asset && !asset.purgedAt ? asset : undefined;
  };
  const master = live(version.masterAssetId);
  const preview = live(version.previewAssetId);
  const referenced = version.elements
    .map((element) => live(element.assetId ?? null))
    .filter((asset): asset is TemplateSceneAsset => asset !== undefined);
  const unique = new Map(
    [master, preview, ...referenced]
      .filter((asset): asset is TemplateSceneAsset => asset !== undefined)
      .map((asset) => [asset.id, asset]),
  );
  return {
    ...base,
    elements: version.elements,
    master: master ? toAssetView(master) : null,
    preview: preview ? toAssetView(preview) : null,
    assets: [...unique.values()].map(toAssetView),
  };
}

export function toMessageView(message: TemplateSceneMessage): SceneMessageView {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    attachments: message.attachments,
    status: message.status,
    versionId: message.versionId,
    createdByUserId: message.createdByUserId,
    createdAt: message.createdAt.toISOString(),
  };
}

export function toSummaryView(scene: TemplateScene): SceneSummaryView {
  return {
    id: scene.id,
    name: scene.name,
    formatId: scene.formatId,
    artWidthCm: scene.artWidthCm,
    artHeightCm: scene.artHeightCm,
    widthPx: scene.widthPx,
    heightPx: scene.heightPx,
    pixelsPerCm: scene.pixelsPerCm,
    revision: scene.revision,
    totalCostUsd: scene.totalCostUsd,
    createdByUserId: scene.createdByUserId,
    createdAt: scene.createdAt.toISOString(),
    updatedAt: scene.updatedAt.toISOString(),
  };
}
