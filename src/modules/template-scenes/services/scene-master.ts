import { EntityManager } from 'typeorm';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { SceneFilesService } from './scene-files.service';

/**
 * A master da versão em disco (R73): `null` sem imagem, com o asset apagado pela retenção (`purgedAt`) ou com o
 * arquivo ausente. Leitura única, usada pelo contexto do Diretor e pela camada pelo chat.
 */
export async function readVersionMaster(
  manager: EntityManager,
  files: Pick<SceneFilesService, 'read'>,
  version: Pick<TemplateSceneVersion, 'masterAssetId'> | null,
): Promise<Buffer | null> {
  if (!version?.masterAssetId) return null;
  const asset = await manager.findOne(TemplateSceneAsset, { where: { id: version.masterAssetId } });
  if (!asset || asset.purgedAt) return null;
  try {
    return await files.read(asset.url);
  } catch {
    return null;
  }
}
