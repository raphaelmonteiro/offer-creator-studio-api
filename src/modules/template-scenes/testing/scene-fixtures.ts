import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { facesOfLayout, faceZones } from '../domain/scene-faces';
import { findSceneFormat, SceneFormatSpec } from '../domain/scene-formats';
import { SceneAssetRole, SceneVersionOperation, SceneVersionStatus } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { SceneFilesService } from '../services/scene-files.service';

/** Fábricas de linhas para os specs com banco (um lugar só, sem repetir nos testes). */

/**
 * Cena de teste com as faces do layout (uma só por padrão), como a criação pela API: toda cena tem a face 0, e a versão
 * atual dela é o que o código lê. Use `pointFace` para apontar a versão atual (a face e o espelho da cena).
 */
export async function insertScene(
  dataSource: DataSource,
  overrides: Partial<TemplateScene> = {},
): Promise<TemplateScene> {
  const scene = await dataSource.manager.save(
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
  const format = findSceneFormat(scene.formatId) as SceneFormatSpec;
  await dataSource.manager.insert(
    TemplateSceneFace,
    facesOfLayout(scene.layout ?? 'single').map((spec) => ({
      sceneId: scene.id,
      index: spec.index,
      key: spec.key,
      label: spec.label,
      zones: faceZones(format, spec.key),
      widthPx: scene.widthPx,
      heightPx: scene.heightPx,
      currentVersionId: scene.currentVersionId,
      templateId: scene.approvedTemplateId,
    })),
  );
  return scene;
}

/**
 * Aponta a versão atual da face e, na face 0, o espelho da cena (o que `setFaceCurrentVersion` faz em produção, sem a
 * `revision`). Devolve `scene` com o campo atualizado em memória.
 */
export async function pointFace<T extends { id: string; currentVersionId: string | null }>(
  dataSource: DataSource,
  scene: T,
  versionId: string | null,
  faceIndex = 0,
): Promise<T> {
  await dataSource.manager.update(
    TemplateSceneFace,
    { sceneId: scene.id, index: faceIndex },
    { currentVersionId: versionId },
  );
  if (faceIndex === 0) {
    await dataSource.manager.update(
      TemplateScene,
      { id: scene.id },
      { currentVersionId: versionId },
    );
    scene.currentVersionId = versionId;
  }
  return scene;
}

/** Aponta o template da face e, na face 0, `approvedTemplateId` da cena. */
export async function pointFaceTemplate(
  dataSource: DataSource,
  sceneId: string,
  templateId: string | null,
  faceIndex = 0,
): Promise<void> {
  await dataSource.manager.update(TemplateSceneFace, { sceneId, index: faceIndex }, { templateId });
  if (faceIndex === 0) {
    await dataSource.manager.update(
      TemplateScene,
      { id: sceneId },
      { approvedTemplateId: templateId },
    );
  }
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

/**
 * Versão `ready` com master e prévia próprias e o arquivo de cada uma em disco (`files`), para os specs do GC e da
 * retenção. Não torna a versão atual.
 */
export async function insertReadyOnDisk(
  dataSource: DataSource,
  files: Pick<SceneFilesService, 'write'>,
  scene: Pick<TemplateScene, 'id'>,
  input: { number: number; extra?: Partial<TemplateSceneVersion> },
) {
  const { number } = input;
  const version = await insertVersion(dataSource, scene.id, { number, ...input.extra });
  const make = async (role: 'master' | 'preview') => {
    const written = await files.write(
      scene.id,
      version.id,
      `${role}-${number}.png`,
      Buffer.from(`${role}${number}`),
    );
    return insertAsset(dataSource, version, role, { url: written.url });
  };
  const master = await make('master');
  const preview = await make('preview');
  await dataSource.manager.update(
    TemplateSceneVersion,
    { id: version.id },
    { masterAssetId: master.id, previewAssetId: preview.id },
  );
  return { version, master, preview };
}
