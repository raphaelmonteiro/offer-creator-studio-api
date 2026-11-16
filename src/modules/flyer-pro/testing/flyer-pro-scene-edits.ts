import { DataSource } from 'typeorm';
import { SceneElement } from '../../template-scenes/domain/scene.types';
import { TemplateSceneVersion } from '../../template-scenes/entities/template-scene-version.entity';
import { buildSceneOutputs } from '../../template-scenes/services/scene-output';
import {
  insertAsset,
  insertVersion,
  pointFace,
} from '../../template-scenes/testing/scene-fixtures';
import { layer, Rgb, solidPng } from '../../template-scenes/testing/scene-template-fixtures';
import { SceneSeeder, SeededScene } from '../../../shared/testing/e2e-seed-scenes';

/**
 * Mudanças que a fixture do Encarte Pro faz numa cena já projetada, pelas mesmas peças do worker (versão `ready` com
 * master e prévia, e o job de sincronização real): "cena refeita", camadas e renomear. O que a projeção não produz
 * (template apagado pela API) é só um `DELETE`.
 */

/** O que a cena refeita ganha: arte de outra cor (muda o `pictorialKey`) e, se pedido, logo e texto em camada. */
export interface RedoChange {
  faceIndex?: number;
  color?: Rgb;
  /** Logo no cabeçalho e texto no rodapé, como a cena do Templates v2 com camadas. */
  layers?: boolean;
}

async function nextVersionNumber(dataSource: DataSource, sceneId: string): Promise<number> {
  const [{ next }] = await dataSource.query(
    `SELECT COALESCE(max(number), 0) + 1 AS next FROM template_scene_versions WHERE "sceneId" = $1`,
    [sceneId],
  );
  return Number(next);
}

/** Logo (PNG de 60x30, asset da cena) no cabeçalho e texto no rodapé: as camadas que viram `elements` do template. */
async function layerElements(
  seeder: SceneSeeder,
  version: TemplateSceneVersion,
): Promise<SceneElement[]> {
  const written = await seeder.files.write(
    version.sceneId,
    version.id,
    'logo-fixture.png',
    await solidPng(60, 30, [250, 250, 0]),
  );
  const logo = await insertAsset(seeder.dataSource, version, 'logo', {
    url: written.url,
    width: 60,
    height: 30,
  });
  return [
    layer({ id: 'logo-1', kind: 'logo', name: 'Logo', assetId: logo.id, x: 0.5, y: 0.04, z: 2 }),
    layer({
      id: 'texto-1',
      kind: 'text',
      name: 'Texto',
      text: 'Ofertas da semana',
      fontFamily: 'Georgia',
      fontSize: 4,
      color: '#ffffff',
      x: 0.5,
      y: 0.96,
      w: 0.5,
      aspect: 6,
      z: 3,
    }),
  ];
}

/**
 * Nova versão atual da face, com `revision` maior, e o job de sincronização do worker: o template da face é projetado
 * de novo (mesmo id, `fingerprint` novo). Sem `layers`, a cena fica sem camadas.
 */
export async function redoScene(
  seeder: SceneSeeder,
  scene: Pick<SeededScene, 'id'>,
  change: RedoChange = {},
): Promise<void> {
  const { dataSource, files } = seeder;
  const faceIndex = change.faceIndex ?? 0;
  const [face] = await dataSource.query(
    `SELECT "widthPx", "heightPx" FROM template_scene_faces WHERE "sceneId" = $1 AND "index" = $2`,
    [scene.id, faceIndex],
  );
  const version = await insertVersion(dataSource, scene.id, {
    number: await nextVersionNumber(dataSource, scene.id),
    faceIndex,
    elements: [],
  });
  const outputs = await buildSceneOutputs(
    await solidPng(face.widthPx, face.heightPx, change.color ?? [30, 160, 90]),
  );
  const ids: string[] = [];
  for (const [role, file] of [
    ['master', outputs.master],
    ['preview', outputs.preview],
  ] as const) {
    const written = await files.write(scene.id, version.id, file.filename, file.buffer);
    const asset = await insertAsset(dataSource, version, role, {
      url: written.url,
      width: file.width,
      height: file.height,
      bytes: written.bytes,
    });
    ids.push(asset.id);
  }
  version.masterAssetId = ids[0];
  version.previewAssetId = ids[1];
  if (change.layers) version.elements = await layerElements(seeder, version);
  await dataSource.manager.save(version);
  await pointFace(dataSource, { id: scene.id, currentVersionId: null }, version.id, faceIndex);
  await dataSource.query(`UPDATE template_scenes SET revision = revision + 1 WHERE id = $1`, [
    scene.id,
  ]);
  await seeder.sync.process({ sceneId: scene.id }, 'fixture-redo');
}

/** Renomeia a cena e projeta de novo: muda só o `fingerprint` (o nome entra nele), não o `pictorialKey`. */
export async function renameScene(
  seeder: SceneSeeder,
  scene: Pick<SeededScene, 'id'>,
  name: string,
): Promise<void> {
  await seeder.dataSource.query(`UPDATE template_scenes SET name = $2 WHERE id = $1`, [
    scene.id,
    name,
  ]);
  await seeder.sync.process({ sceneId: scene.id }, 'fixture-rename');
}

/**
 * Apaga o template de uma face como `DELETE /v1/templates/:id` (`templates.service.ts`): a linha some e a face continua
 * apontando para o id. `forget` também zera o `templateId` da face, que é a face que nunca foi projetada.
 */
export async function deleteFaceTemplate(
  dataSource: DataSource,
  scene: SeededScene,
  key: string,
  options: { forget?: boolean } = {},
): Promise<void> {
  const face = scene.faces.find((item) => item.key === key);
  if (!face) throw new Error(`A cena ${scene.name} não tem a face ${key}`);
  await dataSource.query(`DELETE FROM templates WHERE id = $1`, [face.templateId]);
  if (options.forget) {
    await dataSource.query(
      `UPDATE template_scene_faces SET "templateId" = NULL WHERE "sceneId" = $1 AND key = $2`,
      [scene.id, key],
    );
    if (face.index === 0) {
      await dataSource.query(
        `UPDATE template_scenes SET "approvedTemplateId" = NULL WHERE id = $1`,
        [scene.id],
      );
    }
  }
}
