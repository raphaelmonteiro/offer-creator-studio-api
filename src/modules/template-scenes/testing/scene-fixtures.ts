import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { SceneAssetRole, SceneVersionOperation, SceneVersionStatus } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';

/** Fábricas de linhas para os specs com banco (um lugar só, sem repetir nos testes). */

export function insertScene(
  dataSource: DataSource,
  overrides: Partial<TemplateScene> = {},
): Promise<TemplateScene> {
  return dataSource.manager.save(
    dataSource.manager.create(TemplateScene, {
      name: 'Cena de teste',
      formatId: 'folheto-27x54',
      artWidthCm: 27.5,
      artHeightCm: 55,
      widthPx: 1920,
      heightPx: 3840,
      pixelsPerCm: 69.8182,
      ...overrides,
    }),
  );
}

export function insertVersion(
  dataSource: DataSource,
  sceneId: string,
  overrides: Partial<TemplateSceneVersion> & { number: number },
): Promise<TemplateSceneVersion> {
  return dataSource.manager.save(
    dataSource.manager.create(TemplateSceneVersion, {
      sceneId,
      operation: 'generate' as SceneVersionOperation,
      status: 'ready' as SceneVersionStatus,
      correlationId: randomUUID(),
      ...overrides,
    }),
  );
}

export function insertAsset(
  dataSource: DataSource,
  version: Pick<TemplateSceneVersion, 'id' | 'sceneId'>,
  role: SceneAssetRole,
  overrides: Partial<TemplateSceneAsset> = {},
): Promise<TemplateSceneAsset> {
  return dataSource.manager.save(
    dataSource.manager.create(TemplateSceneAsset, {
      versionId: version.id,
      sceneId: version.sceneId,
      role,
      url: `/uploads/template-scenes/${version.sceneId}/${version.id}/${role}-${randomUUID()}.png`,
      width: 1920,
      height: 3840,
      bytes: 1000,
      ...overrides,
    }),
  );
}

/** Versão `ready` com master e prévia, e a cena apontando para ela. */
export async function insertReadyVersion(
  dataSource: DataSource,
  scene: TemplateScene,
  number: number,
  overrides: Partial<TemplateSceneVersion> = {},
): Promise<{
  version: TemplateSceneVersion;
  master: TemplateSceneAsset;
  preview: TemplateSceneAsset;
}> {
  const version = await insertVersion(dataSource, scene.id, { number, ...overrides });
  const master = await insertAsset(dataSource, version, 'master');
  const preview = await insertAsset(dataSource, version, 'preview', { width: 512, height: 1024 });
  version.masterAssetId = master.id;
  version.previewAssetId = preview.id;
  await dataSource.manager.save(version);
  return { version, master, preview };
}

export function insertMessage(
  dataSource: DataSource,
  sceneId: string,
  overrides: Partial<TemplateSceneMessage> = {},
): Promise<TemplateSceneMessage> {
  return dataSource.manager.save(
    dataSource.manager.create(TemplateSceneMessage, {
      sceneId,
      role: 'user',
      content: 'mensagem',
      ...overrides,
    }),
  );
}
