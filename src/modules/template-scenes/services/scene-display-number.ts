import { EntityManager } from 'typeorm';
import { SceneVersionOperation } from '../domain/scene.types';

/** Uma versão que o cliente enxerga: `ready` com master, numerada em sequência dentro da face (PV-4). */
export interface DisplayedVersion {
  id: string;
  faceIndex: number;
  /** `number` interno (toda mensagem consome um). */
  number: number;
  displayNumber: number;
  operation: SceneVersionOperation;
  createdAt: Date;
}

/**
 * Versões exibidas da cena, em ordem. O `displayNumber` é a posição entre as versões `ready` com
 * `masterAssetId` não nulo (`generate`, `redraw`, `manual`, `set_layer`, `restore`, `derive_face`...), em ordem de
 * `number`, **dentro de cada face** (`PARTITION BY "faceIndex"`, PV-4; o `number` interno segue único na cena).
 * **`ROW_NUMBER()` na face inteira, nunca sobre a página**: `loadDetail` pagina de 50 em 50, e o número tem de ser o
 * mesmo na primeira e na última página. Master podada continua contando, então o número não muda com o tempo. Com
 * `faceIndex`, só as versões dessa face.
 */
export async function loadDisplayedVersions(
  manager: EntityManager,
  sceneId: string,
  faceIndex?: number,
): Promise<DisplayedVersion[]> {
  const rows: Array<{
    id: string;
    faceIndex: number;
    number: number;
    displayNumber: string;
    operation: SceneVersionOperation;
    createdAt: Date;
  }> = await manager.query(
    `SELECT * FROM (
       SELECT id, "faceIndex", "number", operation, "createdAt",
              ROW_NUMBER() OVER (PARTITION BY "faceIndex" ORDER BY "number") AS "displayNumber"
         FROM template_scene_versions
        WHERE "sceneId" = $1 AND status = 'ready' AND "masterAssetId" IS NOT NULL
     ) shown
      WHERE $2::int IS NULL OR "faceIndex" = $2
      ORDER BY "number"`,
    [sceneId, faceIndex ?? null],
  );
  return rows.map((row) => ({
    ...row,
    faceIndex: Number(row.faceIndex),
    displayNumber: Number(row.displayNumber),
  }));
}

/** Número exibido de cada versão da cena, por id (versão sem imagem não tem). */
export async function displayNumbersOf(
  manager: EntityManager,
  sceneId: string,
): Promise<Map<string, number>> {
  const versions = await loadDisplayedVersions(manager, sceneId);
  return new Map(versions.map((version) => [version.id, version.displayNumber]));
}
