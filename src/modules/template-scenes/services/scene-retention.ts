import { EntityManager, In } from 'typeorm';
import {
  SCENE_PROTECTABLE_ROLES,
  sceneGcConfigFromEnv,
  selectProtectedSceneAssets,
} from '../../../shared/gc/template-scenes-gc.rules';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';

/**
 * Poda de master e prévia (D-12, PV-5): marca `expiresAt = agora` nas que saíram do conjunto
 * protegido (as N versões `ready` mais recentes **de cada face** (PV-10), incluídas as que o juiz reprovou, as
 * aprovadas e a atual de cada face, D-20) e limpa a marca das que voltaram.
 * Roda no `manager` da transação, sob o lock da cena, em todo caminho que cria versão `ready`
 * (processor, `PATCH elements` e `restore`). Quem apaga o arquivo é o GC.
 */
export async function pruneSceneAssets(
  manager: EntityManager,
  scene: Pick<TemplateScene, 'id' | 'currentVersionId'>,
  now: Date = new Date(),
): Promise<void> {
  const sceneId = scene.id;
  const versions = await manager.find(TemplateSceneVersion, {
    where: { sceneId },
    select: [
      'id',
      'faceIndex',
      'number',
      'status',
      'masterAssetId',
      'previewAssetId',
      'approvedAt',
    ],
  });
  const faces = await manager.find(TemplateSceneFace, {
    where: { sceneId },
    select: ['id', 'currentVersionId'],
  });
  const currents = [scene.currentVersionId, ...faces.map((face) => face.currentVersionId)].filter(
    Boolean,
  ) as string[];
  const protectedIds = selectProtectedSceneAssets(
    versions,
    sceneGcConfigFromEnv().mastersKept,
    currents,
  );
  const assets = await manager.find(TemplateSceneAsset, {
    where: { sceneId, role: In([...SCENE_PROTECTABLE_ROLES]) as never },
  });
  const toExpire = assets.filter((a) => !a.purgedAt && !protectedIds.has(a.id) && !a.expiresAt);
  const toKeep = assets.filter((a) => !a.purgedAt && protectedIds.has(a.id) && a.expiresAt);
  if (toExpire.length > 0) {
    await manager.update(
      TemplateSceneAsset,
      { id: In(toExpire.map((a) => a.id)) },
      { expiresAt: now },
    );
  }
  if (toKeep.length > 0) {
    await manager.update(
      TemplateSceneAsset,
      { id: In(toKeep.map((a) => a.id)) },
      { expiresAt: null },
    );
  }
}
