import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { E2E_CDN_URL } from '../../../shared/testing/e2e-seed-identity';
import { describeIfE2eDb, openE2eDb } from '../../../shared/testing/e2e-test-db';
import { createFlyerProFixture, FlyerProFixture, uniqueSuffix } from './flyer-pro-scene-fixture';

const one = async (dataSource: DataSource, sql: string, ...params: unknown[]) =>
  (await dataSource.query(sql, params))[0];

async function rowsOf(dataSource: DataSource, fixture: FlyerProFixture) {
  const ids = Object.values(fixture.scenes).map((scene) => scene.id);
  const count = async (sql: string) => Number((await one(dataSource, sql, ids)).count);
  return {
    scenes: await count(`SELECT count(*) FROM template_scenes WHERE id = ANY($1::uuid[])`),
    faces: await count(
      `SELECT count(*) FROM template_scene_faces WHERE "sceneId" = ANY($1::uuid[])`,
    ),
    templates: await count(
      `SELECT count(*) FROM templates WHERE configuration->'source'->>'sceneId' = ANY($1)`,
    ),
  };
}

const templateOf = async (dataSource: DataSource, sceneId: string, key: string) =>
  one(
    dataSource,
    `SELECT t.id, t.configuration FROM templates t
     WHERE t.configuration->'source'->>'sceneId' = $1 AND t.configuration->'source'->>'faceKey' = $2`,
    sceneId,
    key,
  );

describeIfE2eDb('Fixture de cenas do Encarte Pro (banco chroma_x_e2e)', () => {
  jest.setTimeout(240_000);
  let dataSource: DataSource;
  let uploadsDir: string;
  const suffix = uniqueSuffix();

  beforeAll(async () => {
    dataSource = await openE2eDb();
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyer-pro-fixture-'));
  });
  afterAll(async () => {
    await dataSource?.destroy();
    if (uploadsDir) await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  const create = () =>
    createFlyerProFixture(dataSource, { uploadsDir, cdnUrl: E2E_CDN_URL }, suffix);

  it('cria cada caso pelas linhas certas, apaga tudo e repete sem erro de chave única', async () => {
    for (const _round of [1, 2]) {
      const fixture = await create();
      const { scenes } = fixture;
      expect(Object.values(scenes).every((scene) => scene.name.endsWith(suffix))).toBe(true);

      const before = await rowsOf(dataSource, fixture);
      expect(before.scenes).toBe(Object.keys(scenes).length);

      // Frente e verso só com a Frente: o Verso nunca teve template.
      const back = await one(
        dataSource,
        `SELECT "templateId" FROM template_scene_faces WHERE "sceneId" = $1 AND key = 'back'`,
        scenes.frontOnly.id,
      );
      expect(back.templateId).toBeNull();
      expect(await templateOf(dataSource, scenes.frontOnly.id, 'back')).toBeUndefined();
      // Frente apagada pela API: a face ainda aponta para o id.
      const front = await one(
        dataSource,
        `SELECT "templateId" FROM template_scene_faces WHERE "sceneId" = $1 AND key = 'front'`,
        scenes.frontDeleted.id,
      );
      expect(front.templateId).not.toBeNull();
      expect(await templateOf(dataSource, scenes.frontDeleted.id, 'front')).toBeUndefined();
      expect(await templateOf(dataSource, scenes.frontDeleted.id, 'back')).toBeDefined();

      // Capa de 10 cm: projetado 10,25 e as zonas da face da cena no padrão.
      const outer = await templateOf(dataSource, scenes.cover10.id, 'outer');
      expect(outer.configuration.header.heightCm).toBe(10.25);
      const zones = await one(
        dataSource,
        `SELECT zones FROM template_scene_faces WHERE "sceneId" = $1 AND key = 'outer'`,
        scenes.cover10.id,
      );
      expect(zones.zones.header.h).toBeCloseTo(0.15, 4);

      // Camadas: logo no cabeçalho e texto no rodapé, projetados pela rotina do worker.
      const layered = (await templateOf(dataSource, scenes.layers.id, 'single')).configuration;
      expect(layered.header.elements.map((e: { type: string }) => e.type)).toEqual(['image']);
      expect(layered.footer.elements.map((e: { type: string }) => e.type)).toEqual(['text']);

      // Cena excluída com o template órfão; reserva da face 0; sem marcador; id inexistente.
      expect(
        (
          await one(
            dataSource,
            `SELECT "deletedAt" FROM template_scenes WHERE id = $1`,
            scenes.deleted.id,
          )
        ).deletedAt,
      ).not.toBeNull();
      expect(await templateOf(dataSource, scenes.deleted.id, 'single')).toBeDefined();
      const reserve = await one(
        dataSource,
        `SELECT f."templateId", s."approvedTemplateId" FROM template_scene_faces f JOIN template_scenes s ON s.id = f."sceneId" WHERE s.id = $1 AND f."index" = 0`,
        scenes.reserve.id,
      );
      expect(reserve.templateId).toBeNull();
      expect(reserve.approvedTemplateId).not.toBeNull();
      const unmarked = await one(
        dataSource,
        `SELECT t.configuration FROM template_scene_faces f JOIN templates t ON t.id = f."templateId" WHERE f."sceneId" = $1`,
        scenes.unmarked.id,
      );
      expect(unmarked.configuration.source).toBeUndefined();
      const dangling = await one(
        dataSource,
        `SELECT count(*) FROM templates t JOIN template_scene_faces f ON f."templateId" = t.id WHERE f."sceneId" = $1`,
        scenes.dangling.id,
      );
      expect(Number(dangling.count)).toBe(0);

      await fixture.cleanup();
      expect(await rowsOf(dataSource, fixture)).toEqual({ scenes: 0, faces: 0, templates: 0 });
      expect(
        Number(
          (
            await one(
              dataSource,
              `SELECT count(*) FROM templates WHERE name = $1`,
              `Sem marcador ${suffix}`,
            )
          ).count,
        ),
      ).toBe(0);
      expect(await fs.readdir(path.join(uploadsDir, 'templates')).catch(() => [])).toEqual([]);
    }
  });
});
