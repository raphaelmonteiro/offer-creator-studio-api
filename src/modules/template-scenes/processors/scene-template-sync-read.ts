import { EntityManager, In } from 'typeorm';
import { findSceneFormat } from '../domain/scene-formats';
import { projectionKeys } from '../domain/scene-template-keys';
import { SceneTemplateConfiguration, TemplateImageUrls } from '../domain/scene-template.types';
import { SceneElement } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { Template } from '../../templates/entities/template.entity';
import { ProjectionSource } from '../services/scene-template-projection';

/** A cena e a versão atual `ready` com master, lidas sem trava. */
export interface CurrentScene {
  scene: TemplateScene;
  version: TemplateSceneVersion & { masterAssetId: string };
}

/**
 * `null` para cena inexistente ou excluída, sem versão atual, versão que não está `ready` ou sem master (cena sem
 * imagem não tem template, D-9).
 */
export async function readCurrentScene(
  manager: EntityManager,
  sceneId: string,
): Promise<CurrentScene | null> {
  const scene = await manager.findOneBy(TemplateScene, { id: sceneId });
  if (!scene?.currentVersionId) return null;
  const version = await manager.findOneBy(TemplateSceneVersion, { id: scene.currentVersionId });
  if (!version || version.status !== 'ready' || !version.masterAssetId) return null;
  return { scene, version: version as CurrentScene['version'] };
}

/** O que a projeção lê da cena, com as duas impressões digitais de PV-12. */
export function projectionSourceOf(current: CurrentScene): ProjectionSource {
  const { scene, version } = current;
  const format = findSceneFormat(scene.formatId);
  if (!format) throw new Error(`Formato da cena sem medidas: ${scene.formatId}`);
  return {
    sceneId: scene.id,
    name: scene.name,
    format,
    widthPx: scene.widthPx,
    heightPx: scene.heightPx,
    versionId: version.id,
    sceneRevision: scene.revision,
    elements: version.elements,
    keys: projectionKeys({
      formatId: scene.formatId,
      name: scene.name,
      masterAssetId: version.masterAssetId,
      elements: version.elements,
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
  return {
    full: config.bodyBackground.imageUrl,
    header: config.header.background.imageUrl,
    footer: config.footer.background.imageUrl,
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
