import type { EntityManager } from 'typeorm';
import type { FaceRow, SceneRow } from '../domain/flyer-pro-template-rows';
import {
  analyzeSceneTemplate,
  SceneTemplateAnalysis,
  templateIdsOf,
} from '../domain/flyer-pro-template-entry';
import type { FlyerProSceneReader } from './flyer-pro-scene.reader';

function groupBySceneId(faces: FaceRow[]): Map<string, FaceRow[]> {
  const groups = new Map<string, FaceRow[]>();
  for (const face of faces) groups.set(face.sceneId, [...(groups.get(face.sceneId) ?? []), face]);
  return groups;
}

/**
 * As faces das cenas e os templates que elas apontam (duas consultas para todas as cenas, sem N+1) e a regra aplicada a
 * cada uma. Quem chama é a lista (N7) e o montador da cópia, que dão por isso o mesmo resultado.
 */
export async function analyzeScenes(
  reader: FlyerProSceneReader,
  manager: EntityManager,
  scenes: SceneRow[],
): Promise<SceneTemplateAnalysis[]> {
  if (scenes.length === 0) return [];
  const faces = groupBySceneId(
    await reader.faceRows(
      manager,
      scenes.map((scene) => scene.id),
    ),
  );
  const ids = [
    ...new Set(scenes.flatMap((scene) => templateIdsOf(scene, faces.get(scene.id) ?? []))),
  ];
  const templates = new Map((await reader.templateRows(manager, ids)).map((row) => [row.id, row]));
  return scenes.map((scene) =>
    analyzeSceneTemplate({ scene, faces: faces.get(scene.id) ?? [], templates }),
  );
}
