import { EntityManager } from 'typeorm';
import {
  FACE_KEYS,
  FaceKey,
  faceKeyOf,
  facesOfLayout,
  faceZones,
  SceneLayout,
} from '../domain/scene-faces';
import { findSceneFormat, SceneFormatSpec } from '../domain/scene-formats';
import { sameZones } from '../domain/scene-tabloid';
import { SceneZones } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { faceNotFound, invalidBody } from '../scene.errors';

/**
 * Leitura e escrita das faces da cena (change add-template-scene-faces). Toda atribuição de versão atual e de template
 * passa por `setFaceCurrentVersion` e `setFaceTemplate`, que mantêm o espelho da face 0 em `template_scenes`
 * (`currentVersionId` e `approvedTemplateId`, D-1). Fora de testes, nada mais grava esses dois campos da cena.
 */

/** As linhas das faces de uma cena nova (mesma transação do `INSERT` da cena). */
export function newFaces(
  scene: Pick<TemplateScene, 'id' | 'widthPx' | 'heightPx'>,
  format: SceneFormatSpec,
  layout: SceneLayout,
): Array<Partial<TemplateSceneFace>> {
  return facesOfLayout(layout).map((spec) => ({
    sceneId: scene.id,
    index: spec.index,
    key: spec.key,
    label: spec.label,
    zones: faceZones(format, spec.key),
    widthPx: scene.widthPx,
    heightPx: scene.heightPx,
  }));
}

/** Faces da cena em ordem de índice. */
export function loadFaces(manager: EntityManager, sceneId: string): Promise<TemplateSceneFace[]> {
  return manager.find(TemplateSceneFace, { where: { sceneId }, order: { index: 'ASC' } });
}

/** A face pelo índice; cena sem a face é erro de dados (toda cena tem a face 0 desde a migration). */
export function loadFace(
  manager: EntityManager,
  sceneId: string,
  faceIndex: number,
): Promise<TemplateSceneFace> {
  return manager.findOneByOrFail(TemplateSceneFace, { sceneId, index: faceIndex });
}

/**
 * A face do pedido: sem `key`, a face 0. `front` também vale para a face única (a tela manda `front` por padrão).
 * Chave que a cena não tem: 422 `FACE_NOT_FOUND` (nada é gravado).
 */
export async function resolveFace(
  manager: EntityManager,
  scene: Pick<TemplateScene, 'id'>,
  key?: FaceKey | null,
): Promise<TemplateSceneFace> {
  return pickFace(await loadFaces(manager, scene.id), key);
}

/** `resolveFace` sobre as faces já lidas: sem `key`, a face 0; `front` vale para a face única; outra chave é 422. */
export function pickFace<T extends Pick<TemplateSceneFace, 'key'>>(
  faces: T[],
  key?: FaceKey | null,
): T {
  if (!key) return faces[0];
  const found = faces.find((face) => face.key === key);
  if (found) return found;
  if (key === 'front' && faces.length === 1) return faces[0];
  throw faceNotFound(key);
}

/** A versão atual da face, ou `null` sem versão. */
export async function currentVersionOf(
  manager: EntityManager,
  face: Pick<TemplateSceneFace, 'currentVersionId'> | null,
): Promise<TemplateSceneVersion | null> {
  if (!face?.currentVersionId) return null;
  return manager.findOne(TemplateSceneVersion, { where: { id: face.currentVersionId } });
}

/** A face tem versão `ready` com master (a imagem existe)? */
export function faceHasImage(
  manager: EntityManager,
  sceneId: string,
  faceIndex: number,
): Promise<boolean> {
  return manager
    .getRepository(TemplateSceneVersion)
    .createQueryBuilder('version')
    .where('version.sceneId = :sceneId AND version.faceIndex = :faceIndex', { sceneId, faceIndex })
    .andWhere(`version.status = 'ready' AND version."masterAssetId" IS NOT NULL`)
    .getExists();
}

/** As zonas da face na criação (as que a versão sem `zones` própria tem). */
function creationZones(scene: Pick<TemplateScene, 'formatId' | 'layout'>, faceIndex: number) {
  const format = findSceneFormat(scene.formatId) as SceneFormatSpec;
  return faceZones(format, faceKeyOf(scene.layout, faceIndex));
}

/**
 * PV-T10: a versão do jornal sem zonas próprias herda as da face em vigor (nulo se iguais às da criação). Chamada
 * antes de salvar a versão que passa a ser a atual sem mudar o cabeçalho (imagem, camada, manual). Versão que já traz
 * `zones` (a que mudou a altura do cabeçalho) e cena que não é jornal ficam como estão.
 */
export async function stampVersionZones(
  manager: EntityManager,
  scene: Pick<TemplateScene, 'id' | 'formatId' | 'layout'>,
  version: Pick<TemplateSceneVersion, 'faceIndex' | 'zones'>,
): Promise<void> {
  if (scene.layout !== 'tabloid' || version.zones) return;
  const face = await loadFace(manager, scene.id, version.faceIndex);
  version.zones = sameZones(face.zones, creationZones(scene, version.faceIndex))
    ? null
    : face.zones;
}

/** As zonas que passam a valer na face quando a versão vira a atual: as dela, ou as da criação (PV-T10). */
async function zonesOfVersion(
  manager: EntityManager,
  scene: Pick<TemplateScene, 'formatId' | 'layout'>,
  input: { faceIndex: number; versionId: string },
): Promise<SceneZones> {
  const version = await manager.findOne(TemplateSceneVersion, {
    where: { id: input.versionId },
    select: { id: true, zones: true },
  });
  return version?.zones ?? creationZones(scene, input.faceIndex);
}

/**
 * A versão passa a ser a atual da face; na face 0, a cena espelha. Atualiza também `scene` em memória, porque o
 * `bumpRevision` que fecha o turno salva a entidade inteira e não pode desfazer o espelho. No jornal, as zonas da face
 * passam a ser as da versão (PV-T10): a altura do cabeçalho acompanha a imagem em "voltar", restaurar e desfazer.
 */
export async function setFaceCurrentVersion(
  manager: EntityManager,
  scene: TemplateScene,
  faceIndex: number,
  versionId: string,
): Promise<void> {
  const zones =
    scene.layout === 'tabloid'
      ? { zones: await zonesOfVersion(manager, scene, { faceIndex, versionId }) }
      : {};
  const result = await manager.update(
    TemplateSceneFace,
    { sceneId: scene.id, index: faceIndex },
    { currentVersionId: versionId, ...zones },
  );
  if (!result.affected) throw new Error(`Cena ${scene.id} sem a face ${faceIndex}`);
  if (faceIndex !== 0) return;
  scene.currentVersionId = versionId;
  await manager.update(TemplateScene, { id: scene.id }, { currentVersionId: versionId });
}

/** O template passa a ser o da face; na face 0, `approvedTemplateId` da cena espelha. */
export async function setFaceTemplate(
  manager: EntityManager,
  scene: Pick<TemplateScene, 'id' | 'approvedTemplateId'>,
  faceIndex: number,
  templateId: string | null,
): Promise<void> {
  await manager.update(TemplateSceneFace, { sceneId: scene.id, index: faceIndex }, { templateId });
  if (faceIndex !== 0) return;
  scene.approvedTemplateId = templateId;
  await manager.query(`UPDATE template_scenes SET "approvedTemplateId" = $1 WHERE id = $2`, [
    templateId,
    scene.id,
  ]);
}

/** A chave da face de uma versão, sem consultar o banco (as faces nunca são reordenadas, PV-1). */
export const faceKeyOfVersion = (
  scene: Pick<TemplateScene, 'layout'>,
  version: Pick<TemplateSceneVersion, 'faceIndex'>,
): FaceKey => faceKeyOf(scene.layout, version.faceIndex);

/** Campo `face` de um corpo sem DTO (multipart): ausente vale a face 0; valor fora das chaves é 400. */
export function parseFaceKey(value: unknown): FaceKey | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && (FACE_KEYS as readonly string[]).includes(value)) {
    return value as FaceKey;
  }
  throw invalidBody('O campo "face" precisa ser single, front, back, outer ou inner.');
}

/**
 * O template da face. A face 0 cai no `approvedTemplateId` da cena quando a face ainda não o guarda (espelho
 * desatualizado, por exemplo uma migration refeita depois de o código antigo criar o template): o job reconhece o
 * template existente como o da face 0 e não cria um segundo.
 */
export const faceTemplateIdOf = (
  scene: Pick<TemplateScene, 'approvedTemplateId'>,
  face: Pick<TemplateSceneFace, 'index' | 'templateId'>,
): string | null => face.templateId ?? (face.index === 0 ? scene.approvedTemplateId : null);
