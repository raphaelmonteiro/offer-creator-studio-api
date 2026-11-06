import { EntityManager } from 'typeorm';
import { SceneVersionOperation } from '../domain/scene.types';

/** Uma versão que o cliente enxerga: `ready` com master, numerada em sequência na cena inteira. */
export interface DisplayedVersion {
  id: string;
  /** `number` interno (toda mensagem consome um). */
  number: number;
  displayNumber: number;
  operation: SceneVersionOperation;
  createdAt: Date;
}

/**
 * Versões exibidas da cena, em ordem. O `displayNumber` é a posição entre as versões `ready` com
 * `masterAssetId` não nulo (`generate`, `redraw`, `manual`, `set_layer`, `restore`...), em ordem de
 * `number`. **`ROW_NUMBER()` na cena inteira, nunca sobre a página**: `loadDetail` pagina de 50 em 50, e o
 * número tem de ser o mesmo na primeira e na última página. Master podada continua contando, então o número
 * não muda com o tempo.
 */
export async function loadDisplayedVersions(
  manager: EntityManager,
  sceneId: string,
): Promise<DisplayedVersion[]> {
  const rows: Array<{
    id: string;
    number: number;
    displayNumber: string;
    operation: SceneVersionOperation;
    createdAt: Date;
  }> = await manager.query(
    `SELECT id, "number", operation, "createdAt",
            ROW_NUMBER() OVER (ORDER BY "number") AS "displayNumber"
       FROM template_scene_versions
      WHERE "sceneId" = $1 AND status = 'ready' AND "masterAssetId" IS NOT NULL
      ORDER BY "number"`,
    [sceneId],
  );
  return rows.map((row) => ({ ...row, displayNumber: Number(row.displayNumber) }));
}

/** Número exibido de cada versão da cena, por id (versão sem imagem não tem). */
export async function displayNumbersOf(
  manager: EntityManager,
  sceneId: string,
): Promise<Map<string, number>> {
  const versions = await loadDisplayedVersions(manager, sceneId);
  return new Map(versions.map((version) => [version.id, version.displayNumber]));
}
