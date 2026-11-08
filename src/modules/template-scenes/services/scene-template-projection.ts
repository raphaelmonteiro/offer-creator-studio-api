import { buildTemplateConfiguration, sectionBands } from '../domain/scene-template-config';
import { mapLayersToSections } from '../domain/scene-template-layers';
import { PROJECTION_VERSION, ProjectionKeys } from '../domain/scene-template-keys';
import { SceneFormatSpec } from '../domain/scene-formats';
import { SceneTemplateConfiguration, TemplateImageUrls } from '../domain/scene-template.types';
import { SceneElement } from '../domain/scene.types';
import { SceneTemplateFilesService } from './scene-template-files.service';
import { FlattenOverlay, renderTemplateImages } from './scene-template-render';

/** O que a projeção precisa da cena (lido sem trava pelo job). */
export interface ProjectionSource {
  sceneId: string;
  name: string;
  format: SceneFormatSpec;
  widthPx: number;
  heightPx: number;
  versionId: string;
  sceneRevision: number;
  elements: SceneElement[];
  keys: ProjectionKeys;
}

/** Asset de logo da cena: o arquivo em `uploads/template-scenes/` que a projeção copia. */
export interface LogoAsset {
  id: string;
  url: string;
}

export interface ProjectedTemplate {
  configuration: SceneTemplateConfiguration;
  thumbnailUrl: string;
}

/** Copia as logos usadas pelas camadas e devolve `assetId` → URL da cópia (PV-3). */
export async function copyLogos(
  source: ProjectionSource,
  assets: LogoAsset[],
  files: SceneTemplateFilesService,
): Promise<Map<string, string>> {
  const used = new Set(
    source.elements.filter((e) => e.kind === 'logo' && e.assetId).map((e) => e.assetId),
  );
  const urls = new Map<string, string>();
  for (const asset of assets.filter((a) => used.has(a.id))) {
    urls.set(asset.id, await files.copyLogo(source.sceneId, asset));
  }
  return urls;
}

/** `configuration` a partir das URLs das imagens e das camadas da versão (PV-1, PV-5, PV-9). */
export function configurationFor(
  source: ProjectionSource,
  urls: TemplateImageUrls,
  logos: Map<string, string>,
): SceneTemplateConfiguration {
  const bands = sectionBands(source.format, source.heightPx);
  const sections = mapLayersToSections({
    elements: source.elements,
    widthPx: source.widthPx,
    heightPx: source.heightPx,
    artWidthCm: source.format.artWidthCm,
    ...bands,
    logoUrlOf: (assetId) => logos.get(assetId),
  });
  return buildTemplateConfiguration({
    format: source.format,
    urls,
    ...sections,
    source: {
      kind: 'template-scene',
      sceneId: source.sceneId,
      versionId: source.versionId,
      sceneRevision: source.sceneRevision,
      pictorialKey: source.keys.pictorialKey,
      fingerprint: source.keys.fingerprint,
      projectionVersion: PROJECTION_VERSION,
      syncedAt: new Date().toISOString(),
    },
  });
}

/**
 * Projeção completa (PV-1 a PV-5): achata a master com os elementos `generated`, corta as fatias, grava os quatro
 * arquivos numa pasta nova e monta o `configuration`. Sem banco e sem provedor.
 */
export async function projectFull(
  input: {
    source: ProjectionSource;
    master: Buffer;
    overlays: FlattenOverlay[];
    logos: Map<string, string>;
  },
  files: SceneTemplateFilesService,
): Promise<ProjectedTemplate> {
  const { source } = input;
  const images = await renderTemplateImages({
    master: input.master,
    overlays: input.overlays,
    format: source.format,
  });
  const syncId = files.newSyncId();
  const write = (name: string, buffer: Buffer) =>
    files.writeProjection(source.sceneId, syncId, name, buffer);
  const urls: TemplateImageUrls = {
    full: await write('full.jpg', images.full),
    header: await write('header.jpg', images.header),
    footer: await write('footer.jpg', images.footer),
    thumbnail: await write('thumbnail.jpg', images.thumbnail),
  };
  return {
    configuration: configurationFor(source, urls, input.logos),
    thumbnailUrl: urls.thumbnail,
  };
}
