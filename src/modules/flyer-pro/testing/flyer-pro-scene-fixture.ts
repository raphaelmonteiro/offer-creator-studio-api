import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DataSource } from 'typeorm';
import {
  createSceneSeeder,
  SceneSeeder,
  SeededScene,
  SeedFileTarget,
  seedScene,
} from '../../../shared/testing/e2e-seed-scenes';
import { findSceneFormat } from '../../template-scenes/domain/scene-formats';
import { tabloidZones } from '../../template-scenes/domain/scene-tabloid';
import { Rgb } from '../../template-scenes/testing/scene-template-fixtures';
import { insertScene } from '../../template-scenes/testing/scene-fixtures';
import { deleteTestScenes } from '../../template-scenes/testing/scene-test-db';
import { deleteFaceTemplate, redoScene, renameScene } from './flyer-pro-scene-edits';

/**
 * Cenas extras do e2e da N7 e do teste do montador, sobre a semente da 05 (A-2). Todos os nomes levam o sufixo único
 * da suíte (sem hífen, para a busca por `5-` achar só "5- folheto"). As cenas são projetadas pela rotina real do
 * worker, como a semente; só o que a projeção não produz é escrito à mão: o template órfão da cena excluída, o
 * template sem marcador e o id inexistente. Não muda `e2e-seed.ts` nem o harness das cenas.
 */

let counter = 0;

/** Sufixo único por execução (hora, processo e contador), só com letras e dígitos. */
export function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}x${process.pid}x${counter}`;
}

const COLORS: Rgb[] = [
  [200, 80, 60],
  [60, 120, 200],
];

export interface FlyerProFixtureScenes {
  /** As cinco cenas com os nomes do banco local, na ordem da lista. */
  single1: SeededScene;
  single2: SeededScene;
  tabloid3: SeededScene;
  tabloid4: SeededScene;
  frontBack5: SeededScene;
  /** Frente e verso só com a Frente projetada (o Verso nunca teve template). */
  frontOnly: SeededScene;
  /** Frente e verso com o template da Frente apagado pela API; o Verso segue pronto. */
  frontDeleted: SeededScene;
  /** Jornal só com a Externa projetada. */
  outerOnly: SeededScene;
  /** Jornal com o cabeçalho da capa em 10 cm (projetado 10,25 cm) e as zonas da face da cena no padrão (15%). */
  cover10: SeededScene;
  /** Face única 27x40 com logo em camada no cabeçalho e texto em camada no rodapé. */
  layers: SeededScene;
  /** `folheto-54x40` de face única com a face pronta, e a mesma sem nenhum template. */
  single54: SeededScene;
  single54Empty: SeededScene;
  single20: SeededScene;
  /** Cena excluída com o template ainda existente. */
  deleted: SeededScene;
  /** Face 0 com `templateId` nulo e `approvedTemplateId` preenchido. */
  reserve: SeededScene;
  /** Face que aponta para um template sem o marcador de cena. */
  unmarked: SeededScene;
  /** Face que aponta para um id de template que não existe. */
  dangling: SeededScene;
  /** Nomes para busca e ordem. */
  pascoa: SeededScene;
  fiftyPercent: SeededScene;
  abaco: SeededScene;
  beta: SeededScene;
  gamaA: SeededScene;
  gamaB: SeededScene;
}

export interface FlyerProFixture {
  suffix: string;
  scenes: FlyerProFixtureScenes;
  seeder: SceneSeeder;
  /** Apaga as cenas, os templates (inclusive o escrito à mão) e os arquivos, na ordem das FKs. */
  cleanup(): Promise<void>;
}

async function readyScene(
  seeder: SceneSeeder,
  name: string,
  formatId: string,
  layout: 'single' | 'front_back' | 'tabloid',
): Promise<SeededScene> {
  return seedScene(seeder, { name, formatId, layout, colors: COLORS });
}

/** Cena de face única sem face projetada, com a face apontando para `templateId`. */
async function sceneWithoutProjection(
  dataSource: DataSource,
  name: string,
  formatId: string,
  templateId: string | null,
): Promise<SeededScene> {
  const format = findSceneFormat(formatId);
  if (!format) throw new Error(`Formato sem medidas: ${formatId}`);
  const scene = await insertScene(dataSource, {
    name,
    formatId,
    artWidthCm: format.artWidthCm,
    artHeightCm: format.artHeightCm,
  });
  if (templateId) {
    await dataSource.query(
      `UPDATE template_scene_faces SET "templateId" = $2 WHERE "sceneId" = $1 AND "index" = 0`,
      [scene.id, templateId],
    );
  }
  return { id: scene.id, name, formatId, layout: 'single', faces: [] };
}

/** O 10 cm da capa: as zonas da Externa pedem cabeçalho de 10 cm e o job projeta a face de novo. */
async function setCoverHeader(seeder: SceneSeeder, scene: SeededScene): Promise<void> {
  const format = findSceneFormat(scene.formatId);
  if (!format) throw new Error(`Formato sem medidas: ${scene.formatId}`);
  await seeder.dataSource.query(
    `UPDATE template_scene_faces SET zones = $2::jsonb WHERE "sceneId" = $1 AND key = 'outer'`,
    [scene.id, JSON.stringify(tabloidZones(format, 'outer', 10))],
  );
  await seeder.sync.process({ sceneId: scene.id }, 'fixture-cover');
  // As zonas guardadas na face da cena voltam ao padrão: a lista lê a projeção, e não elas.
  await seeder.dataSource.query(
    `UPDATE template_scene_faces SET zones = $2::jsonb WHERE "sceneId" = $1 AND key = 'outer'`,
    [scene.id, JSON.stringify(tabloidZones(format, 'outer'))],
  );
}

const withoutFace = (scene: SeededScene, key: string): SeededScene => ({
  ...scene,
  faces: scene.faces.filter((face) => face.key !== key),
});

async function unmarkedTemplate(dataSource: DataSource, name: string): Promise<string> {
  const [row] = await dataSource.query(
    `INSERT INTO templates (name, type, "isDefault", configuration) VALUES ($1, 'full', false, '{}'::jsonb) RETURNING id`,
    [name],
  );
  return row.id;
}

async function removeFiles(target: SeedFileTarget, sceneIds: string[]): Promise<void> {
  await Promise.all(
    sceneIds.flatMap((id) => [
      fs.rm(path.join(target.uploadsDir, 'template-scenes', id), { recursive: true, force: true }),
      fs.rm(path.join(target.uploadsDir, 'templates', `scene-${id}`), {
        recursive: true,
        force: true,
      }),
    ]),
  );
}

const SINGLE = 'folheto-27x40';
const TABLOID = 'folheto-54x40';

/** As cenas que só precisam existir, prontas, para a busca e a ordem. */
async function namedScenes(seeder: SceneSeeder, suffix: string) {
  const make = (name: string) => readyScene(seeder, `${name} ${suffix}`, SINGLE, 'single');
  const pascoa = await make('Ofertas de Páscoa');
  const fiftyPercent = await make('Leve 50% mais');
  const abaco = await make('Ábaco');
  const beta = await make('beta');
  const gamaA = await make('Gama');
  // `seedScene` devolve a mesma cena para o mesmo nome: a segunda "Gama" nasce com outro nome e é renomeada.
  const gamaB = await make('Gama B');
  await renameScene(seeder, gamaB, `Gama ${suffix}`);
  return { pascoa, fiftyPercent, abaco, beta, gamaA, gamaB: { ...gamaB, name: `Gama ${suffix}` } };
}

async function brokenScenes(seeder: SceneSeeder, suffix: string, unmarkedId: string) {
  const { dataSource } = seeder;
  return {
    single54Empty: await sceneWithoutProjection(dataSource, `teste ${suffix}`, TABLOID, null),
    unmarked: await sceneWithoutProjection(
      dataSource,
      `Sem marcador ${suffix}`,
      SINGLE,
      unmarkedId,
    ),
    dangling: await sceneWithoutProjection(
      dataSource,
      `Template sumido ${suffix}`,
      SINGLE,
      randomUUID(),
    ),
  };
}

async function partialScenes(seeder: SceneSeeder, suffix: string) {
  const { dataSource } = seeder;
  const frontOnly = await readyScene(seeder, `Só a frente ${suffix}`, SINGLE, 'front_back');
  await deleteFaceTemplate(dataSource, frontOnly, 'back', { forget: true });
  const frontDeleted = await readyScene(seeder, `Frente apagada ${suffix}`, SINGLE, 'front_back');
  await deleteFaceTemplate(dataSource, frontDeleted, 'front');
  const outerOnly = await readyScene(seeder, `Só a externa ${suffix}`, TABLOID, 'tabloid');
  await deleteFaceTemplate(dataSource, outerOnly, 'inner', { forget: true });
  const reserve = await readyScene(seeder, `Reserva ${suffix}`, SINGLE, 'single');
  await dataSource.query(
    `UPDATE template_scene_faces SET "templateId" = NULL WHERE "sceneId" = $1 AND "index" = 0`,
    [reserve.id],
  );
  const deleted = await readyScene(seeder, `Excluída ${suffix}`, SINGLE, 'single');
  await dataSource.query(`UPDATE template_scenes SET "deletedAt" = now() WHERE id = $1`, [
    deleted.id,
  ]);
  return {
    frontOnly: withoutFace(frontOnly, 'back'),
    frontDeleted: withoutFace(frontDeleted, 'front'),
    outerOnly: withoutFace(outerOnly, 'inner'),
    reserve,
    deleted,
  };
}

/** Cria as cenas da fixture no banco de e2e (cerca de 30 faces projetadas) e devolve a limpeza. */
export async function createFlyerProFixture(
  dataSource: DataSource,
  target: SeedFileTarget,
  suffix: string = uniqueSuffix(),
): Promise<FlyerProFixture> {
  const seeder = createSceneSeeder(dataSource, target);
  const unmarkedId = await unmarkedTemplate(dataSource, `Sem marcador ${suffix}`);
  const named = (n: string, base: string) => `${n} ${base} ${suffix}`;
  const cover10 = await readyScene(seeder, named('Jornal', 'capa de 10 cm'), TABLOID, 'tabloid');
  await setCoverHeader(seeder, cover10);
  const layers = await readyScene(seeder, named('Cena', 'com camadas'), SINGLE, 'single');
  await redoScene(seeder, layers, { layers: true });
  const scenes: FlyerProFixtureScenes = {
    single1: await readyScene(seeder, `1- folheto 27x40 ${suffix}`, SINGLE, 'single'),
    single2: await readyScene(seeder, `2- folheto 27x40 ${suffix}`, SINGLE, 'single'),
    tabloid3: await readyScene(seeder, `3 - folheto 54x40 ${suffix}`, TABLOID, 'tabloid'),
    tabloid4: await readyScene(seeder, `4 - folheto 54x40 ${suffix}`, TABLOID, 'tabloid'),
    frontBack5: await readyScene(seeder, `5- folheto 27x40 ${suffix}`, SINGLE, 'front_back'),
    cover10,
    layers,
    single54: await readyScene(seeder, `Face única de 54 por 40 ${suffix}`, TABLOID, 'single'),
    single20: await readyScene(seeder, `folheto-20x27. ${suffix}`, 'folheto-20x27', 'single'),
    ...(await partialScenes(seeder, suffix)),
    ...(await brokenScenes(seeder, suffix, unmarkedId)),
    ...(await namedScenes(seeder, suffix)),
  };
  const ids = Object.values(scenes).map((scene) => scene.id);
  return {
    suffix,
    scenes,
    seeder,
    async cleanup() {
      await deleteTestScenes(dataSource, ids);
      await dataSource.query(`DELETE FROM templates WHERE id = $1`, [unmarkedId]);
      await removeFiles(target, ids);
    },
  };
}
