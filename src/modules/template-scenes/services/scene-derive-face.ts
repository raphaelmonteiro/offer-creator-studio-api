import { EntityManager } from 'typeorm';
import { FaceKey } from '../domain/scene-faces';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { backAlreadyExists, faceNotFound, frontNotReady } from '../scene.errors';
import { currentVersionOf, faceHasImage, loadFaces } from './scene-faces';

/** A face de origem e a derivada: frente e verso, ou Externa e Interna (as chaves de cada par). */
export interface FrontAndBack {
  front: TemplateSceneFace;
  back: TemplateSceneFace;
}

/** Cada face derivável e a face de que nasce (a cena `front_back` tem `back`; a `tabloid`, `inner`). */
const DERIVED_FROM: Readonly<Partial<Record<FaceKey, FaceKey>>> = { back: 'front', inner: 'outer' };

/** As faces do par; cena sem elas (outro layout) ou chave que não se deriva é 422 `FACE_NOT_FOUND`. */
export async function loadFrontAndBack(
  manager: EntityManager,
  sceneId: string,
  derivedKey: FaceKey = 'back',
): Promise<FrontAndBack> {
  const sourceKey = DERIVED_FROM[derivedKey];
  const faces = await loadFaces(manager, sceneId);
  const back = faces.find((face) => face.key === derivedKey);
  const front = faces.find((face) => face.key === sourceKey);
  if (!sourceKey || !back || !front) throw faceNotFound(derivedKey);
  return { front, back };
}

/**
 * Sob a trava: a frente tem versão atual `ready` com master (422 `FRONT_NOT_READY`) e o verso ainda não tem versão
 * `ready` (409 `BACK_ALREADY_EXISTS`). Devolve a versão da frente, a referência da derivação. Quem chama já conferiu
 * a face, a revisão e o estado ocupado (nessa ordem, no botão).
 */
export async function assertDerivable(
  manager: EntityManager,
  faces: FrontAndBack,
): Promise<TemplateSceneVersion> {
  const frontVersion = await currentVersionOf(manager, faces.front);
  if (!frontVersion || frontVersion.status !== 'ready' || !frontVersion.masterAssetId) {
    throw frontNotReady(faces.back.key);
  }
  if (await faceHasImage(manager, faces.back.sceneId, faces.back.index)) {
    throw backAlreadyExists(faces.back.key);
  }
  return frontVersion;
}
