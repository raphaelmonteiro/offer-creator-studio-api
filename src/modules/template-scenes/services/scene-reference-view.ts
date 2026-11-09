import { EntityManager } from 'typeorm';
import { ReferenceState, ReferenceSummary } from '../domain/scene-reference.types';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import {
  canRetryFrom,
  latestRead,
  readOf,
  revisionsDone,
  revisionsLeftOf,
} from './scene-reference-state';

/** O campo `reference` do detalhe da cena: o cartão "Conceito do encarte" (`null` quando a cena nunca recebeu encarte). */
export interface SceneReferenceView {
  readVersionId: string;
  state: ReferenceState;
  /** O encarte reduzido (miniatura do cartão); vazio se o arquivo saiu do disco. */
  previewUrl: string;
  fileName: string;
  summary: ReferenceSummary | null;
  /** Correções que ainda cabem (D-3: 5 menos as feitas neste encarte). */
  revisionsLeft: number;
  /** "Tentar de novo com o encarte" (D-4): ficha usada e nenhuma edição depois. */
  canRetry: boolean;
}

export async function loadReferenceView(
  manager: EntityManager,
  sceneId: string,
): Promise<SceneReferenceView | null> {
  const version = await latestRead(manager, sceneId);
  const read = version && readOf(version);
  if (!version || !read) return null;
  const asset = await manager.findOne(TemplateSceneAsset, { where: { id: read.assetId } });
  return {
    readVersionId: version.id,
    state: read.state,
    previewUrl: asset && !asset.purgedAt ? asset.url : '',
    fileName: read.origin.fileName,
    summary: read.summary ?? null,
    revisionsLeft: revisionsLeftOf(await revisionsDone(manager, sceneId, read.assetId)),
    canRetry: await canRetryFrom(manager, version),
  };
}
