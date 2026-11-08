import { EntityManager } from 'typeorm';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { backAlreadyExists, faceNotFound, frontNotReady } from '../scene.errors';
import { currentVersionOf, faceHasImage, loadFaces } from './scene-faces';

/** A frente e o verso de uma cena de frente e verso. */
export interface FrontAndBack {
  front: TemplateSceneFace;
  back: TemplateSceneFace;
}

/** As faces da cena `front_back`; cena de uma face (sem `back`) é 422 `FACE_NOT_FOUND`. */
export async function loadFrontAndBack(
  manager: EntityManager,
  sceneId: string,
): Promise<FrontAndBack> {
  const faces = await loadFaces(manager, sceneId);
  const back = faces.find((face) => face.key === 'back');
  const front = faces.find((face) => face.key === 'front');
  if (!back || !front) throw faceNotFound('back');
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
    throw frontNotReady();
  }
  if (await faceHasImage(manager, faces.back.sceneId, faces.back.index)) {
    throw backAlreadyExists();
  }
  return frontVersion;
}
