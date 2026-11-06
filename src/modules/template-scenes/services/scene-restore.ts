import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { versionNotRestorable } from '../scene.errors';
import { nextVersionNumber } from './scene-lock.service';

/** A master da versão ainda está em disco (`purgedAt` nulo)? */
export async function masterOnDisk(
  manager: EntityManager,
  version: Pick<TemplateSceneVersion, 'masterAssetId'>,
): Promise<boolean> {
  if (!version.masterAssetId) return false;
  const master = await manager.findOne(TemplateSceneAsset, {
    where: { id: version.masterAssetId },
  });
  return Boolean(master && !master.purgedAt);
}

/** 410 `VERSION_NOT_RESTORABLE` quando a master foi apagada pela retenção. */
export async function assertMasterOnDisk(
  manager: EntityManager,
  version: Pick<TemplateSceneVersion, 'masterAssetId'>,
): Promise<void> {
  if (!(await masterOnDisk(manager, version))) throw versionNotRestorable();
}

/**
 * Restaura a imagem e as camadas de `source` numa versão `restore` filha dela: mesma master e prévia, sem
 * arquivo novo. Sem lock próprio e sem conferência de cena ocupada: quem chama já está sob o lock da cena.
 * - Sem `reading`, cria a versão (o REST de `restore`, que mantém lock, revisão e `assertSceneIdle`).
 * - Com `reading`, converte a versão de leitura do consumer do Diretor (`queued` para `ready`,
 *   `operation: 'restore'`, `parentVersionId` da origem), sem segunda versão. No consumer a versão de leitura
 *   está `queued`, e `restore` abriria outro lock e daria `SCENE_BUSY`: por isso este trecho é separado.
 */
export async function restoreInto(
  manager: EntityManager,
  scene: TemplateScene,
  source: TemplateSceneVersion,
  options: { reading?: TemplateSceneVersion; userId?: string | null } = {},
): Promise<TemplateSceneVersion> {
  const { reading, userId = null } = options;
  const image = {
    parentVersionId: source.id,
    operation: 'restore' as const,
    masterAssetId: source.masterAssetId,
    previewAssetId: source.previewAssetId,
    elements: structuredClone(source.elements),
  };
  if (reading) {
    reading.status = 'ready';
    reading.step = 'done';
    return manager.save(Object.assign(reading, image));
  }
  return manager.save(
    manager.create(TemplateSceneVersion, {
      sceneId: scene.id,
      number: await nextVersionNumber(manager, scene.id),
      status: 'ready',
      correlationId: randomUUID(),
      createdByUserId: userId,
      ...image,
    }),
  );
}
