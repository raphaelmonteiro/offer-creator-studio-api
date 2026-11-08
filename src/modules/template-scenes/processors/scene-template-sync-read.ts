import { EntityManager, In } from 'typeorm';
import { faceTemplateName } from '../domain/scene-faces';
import { findSceneFormat } from '../domain/scene-formats';
import { projectionKeys } from '../domain/scene-template-keys';
import { SceneTemplateConfiguration, TemplateImageUrls } from '../domain/scene-template.types';
import { SceneElement } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { Template } from '../../templates/entities/template.entity';
import { currentVersionOf, loadFaces } from '../services/scene-faces';
import { ProjectionSource } from '../services/scene-template-projection';

/** A cena, uma face e a versão atual `ready` com master dela, lidas sem trava. */
export interface CurrentFace {
  scene: TemplateScene;
  face: TemplateSceneFace;
  version: TemplateSceneVersion & { masterAssetId: string };
}

/**
 * As faces da cena que têm imagem pronta, uma entrada por face (D-8): a versão atual `ready` com master. Lista vazia
 * para cena inexistente ou excluída e para face sem versão atual, versão que não está `ready` ou sem master (face sem
 * imagem não tem template, D-9).
 */
export async function readCurrentFaces(
  manager: EntityManager,
  sceneId: string,
): Promise<CurrentFace[]> {
  const scene = await manager.findOneBy(TemplateScene, { id: sceneId });
  if (!scene) return [];
  const current: CurrentFace[] = [];
  for (const face of await loadFaces(manager, sceneId)) {
    const version = await currentVersionOf(manager, face);
    if (version?.status === 'ready' && version.masterAssetId) {
      current.push({ scene, face, version: version as CurrentFace['version'] });
    }
  }
  return current;
}

/** O que a projeção lê da face, com as duas impressões digitais de PV-12. */
export function projectionSourceOf(current: CurrentFace): ProjectionSource {
  const { scene, face, version } = current;
  const format = findSceneFormat(scene.formatId);
  if (!format) throw new Error(`Formato da cena sem medidas: ${scene.formatId}`);
  const name = faceTemplateName(scene.name, face);
  return {
    sceneId: scene.id,
    name,
    faceKey: face.key,
    faceIndex: face.index,
    zones: face.zones,
    format,
    widthPx: face.widthPx,
    heightPx: face.heightPx,
    versionId: version.id,
    sceneRevision: scene.revision,
    elements: version.elements,
    keys: projectionKeys({
      formatId: scene.formatId,
      name,
      masterAssetId: version.masterAssetId,
      elements: version.elements,
      face: { key: face.key, zones: face.zones },
    }),
  };
}

export type SyncPlan = 'touch' | 'layers' | 'full';

/** O que fazer com o template que já existe (PV-12): nada além da revisão, só as camadas, ou tudo. */
export function planFor(existing: Template | null, keys: ProjectionSource['keys']): SyncPlan {
  const source = (existing?.configuration as SceneTemplateConfiguration | undefined)?.source;
  if (source?.kind !== 'template-scene') return 'full';
  if (source.fingerprint === keys.fingerprint) return 'touch';
  return source.pictorialKey === keys.pictorialKey ? 'layers' : 'full';
}

/** As URLs das imagens do template existente, reaproveitadas quando só as camadas mudam. */
export function imageUrlsOf(template: Template): TemplateImageUrls {
  const config = template.configuration as SceneTemplateConfiguration;
  const imageOf = (section: SceneTemplateConfiguration['header']): string | undefined =>
    section.background.type === 'image' ? section.background.imageUrl : undefined;
  return {
    full: config.bodyBackground.imageUrl,
    header: imageOf(config.header),
    footer: imageOf(config.footer),
    thumbnail: template.thumbnailUrl as string,
  };
}

/** Assets de logo e de elemento usados pelas camadas; o que faltar ou já foi apagado é falha (PV-15). */
export async function loadLayerAssets(
  manager: EntityManager,
  source: ProjectionSource,
  kind: SceneElement['kind'],
): Promise<TemplateSceneAsset[]> {
  const ids = [
    ...new Set(source.elements.filter((e) => e.kind === kind && e.assetId).map((e) => e.assetId)),
  ] as string[];
  if (ids.length === 0) return [];
  const found = await manager.findBy(TemplateSceneAsset, { id: In(ids), sceneId: source.sceneId });
  const usable = found.filter((asset) => !asset.purgedAt);
  const missing = ids.find((id) => !usable.some((asset) => asset.id === id));
  if (missing) throw new Error(`Arquivo da camada ausente: ${missing}`);
  return usable;
}
