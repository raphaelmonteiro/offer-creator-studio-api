import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { E2E_CDN_URL } from '../../../shared/testing/e2e-seed-identity';
import { describeIfE2eDb, openE2eDb } from '../../../shared/testing/e2e-test-db';
import { deleteFaceTemplate, redoScene, renameScene } from '../testing/flyer-pro-scene-edits';
import { createFlyerProFixture, FlyerProFixture } from '../testing/flyer-pro-scene-fixture';
import { failureOf } from './flyer-pro-template-snapshot.testutil';
import { writeMarks } from '../testing/flyer-pro-templates.e2e.testutil';
import { FlyerProSceneReader } from './flyer-pro-scene.reader';
import { FlyerProTemplateSnapshotService } from './flyer-pro-template-snapshot.service';
import { FlyerProTemplatesService } from './flyer-pro-templates.service';

/**
 * O montador da cópia contra o banco do harness (change 07, task 1.8): as consultas reais, a transação de quem chama
 * e o "Atualizar arte". Pulado sem `FLYER_PRO_E2E_DB_URL`.
 */
describeIfE2eDb('FlyerProTemplateSnapshotService contra o banco de e2e', () => {
  jest.setTimeout(240_000);
  let dataSource: DataSource;
  let uploadsDir: string;
  let fixture: FlyerProFixture;
  let snapshots: FlyerProTemplateSnapshotService;
  let list: FlyerProTemplatesService;

  beforeAll(async () => {
    dataSource = await openE2eDb();
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyer-pro-snapshot-'));
    fixture = await createFlyerProFixture(dataSource, { uploadsDir, cdnUrl: E2E_CDN_URL });
    const reader = new FlyerProSceneReader();
    snapshots = new FlyerProTemplateSnapshotService(dataSource, reader);
    list = new FlyerProTemplatesService(dataSource, reader);
  }, 240_000);

  afterAll(async () => {
    try {
      await fixture?.cleanup();
    } finally {
      await dataSource?.destroy();
      if (uploadsDir) await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  const suiteIds = () => Object.values(fixture.scenes).map((scene) => scene.id);

  it('cena incompleta: 422 INCOMPLETE com ["back"], sem gravar uma linha', async () => {
    const before = await writeMarks(dataSource, suiteIds());
    const failure = await failureOf(snapshots.build(fixture.scenes.frontOnly.id));
    expect(failure.status).toBe(422);
    expect(failure.body).toEqual({
      code: 'FLYER_PRO_TEMPLATE_INCOMPLETE',
      message: 'Este template ainda não tem todas as faces prontas.',
      details: { missingFaces: ['back'] },
    });
    expect(await writeMarks(dataSource, suiteIds())).toEqual(before);
  });

  it('montar duas vezes dá as mesmas faces e deixa as contagens e o updatedAt como estavam', async () => {
    const before = await writeMarks(dataSource, suiteIds());
    const [first, second] = [
      await snapshots.build(fixture.scenes.tabloid3.id),
      await snapshots.build(fixture.scenes.tabloid3.id),
    ];
    expect(second.faces).toEqual(first.faces);
    expect(first.faces.map((face) => face.key)).toEqual(['outer', 'inner']);
    expect(await writeMarks(dataSource, suiteIds())).toEqual(before);
  });

  it('Atualizar arte: a cena refeita deixa a cópia antiga desatualizada e a nova em dia; a excluída recusa', async () => {
    const scene = fixture.scenes.single2;
    const old = await snapshots.build(scene.id);
    expect(await snapshots.statusOf(old)).toEqual({
      available: true,
      usable: true,
      missingFaces: [],
      stale: false,
      staleKind: null,
    });

    await redoScene(fixture.seeder, scene, { color: [10, 90, 200] });
    expect(await snapshots.statusOf(old)).toEqual(
      expect.objectContaining({ stale: true, staleKind: 'art' }),
    );
    const renewed = await snapshots.build(scene.id);
    expect(renewed.faces[0].fingerprint).not.toBe(old.faces[0].fingerprint);
    expect(renewed.faces[0].pictorialKey).not.toBe(old.faces[0].pictorialKey);
    expect(await snapshots.statusOf(renewed)).toEqual(
      expect.objectContaining({ stale: false, staleKind: null }),
    );

    await dataSource.query(`UPDATE template_scenes SET "deletedAt" = now() WHERE id = $1`, [
      scene.id,
    ]);
    expect((await failureOf(snapshots.build(scene.id))).status).toBe(404);
    expect(await snapshots.statusOf(renewed)).toEqual({
      available: false,
      usable: false,
      missingFaces: [],
      stale: false,
      staleKind: null,
    });
  });

  it('só o nome muda: stale com layers (o pictorialKey é o mesmo)', async () => {
    const scene = fixture.scenes.single1;
    const old = await snapshots.build(scene.id);
    await renameScene(fixture.seeder, scene, `${scene.name} renomeada`);
    expect(await snapshots.statusOf(old)).toEqual(
      expect.objectContaining({ stale: true, staleKind: 'layers' }),
    );
  });

  it('template do Verso apagado como o DELETE /v1/templates/:id faz: build recusa e o estado diz o que faltou', async () => {
    const scene = fixture.scenes.frontBack5;
    const copy = await snapshots.build(scene.id);
    await deleteFaceTemplate(dataSource, scene, 'back');
    const failure = await failureOf(snapshots.build(scene.id));
    expect(failure.body).toEqual(
      expect.objectContaining({
        code: 'FLYER_PRO_TEMPLATE_INCOMPLETE',
        details: { missingFaces: ['back'] },
      }),
    );
    expect(await snapshots.statusOf(copy)).toEqual({
      available: true,
      usable: false,
      missingFaces: ['back'],
      stale: true,
      staleKind: 'art',
    });
  });

  it('mesma regra da lista: na cena com camadas, o faces da cópia é o da entrada da N7', async () => {
    const scene = fixture.scenes.layers;
    const { data } = await list.list({ sceneId: scene.id });
    const copy = await snapshots.build(scene.id);
    expect(copy.faces).toEqual(data[0].faces);
    expect(copy.faces[0].header?.elements.map((element) => element.type)).toEqual(['image']);
    expect(copy.faces[0].footer?.elements.map((element) => element.type)).toEqual(['text']);
  });

  it('dentro da transação de quem chama: o nome renomeado e ainda não confirmado aparece; fora, o antigo', async () => {
    const scene = fixture.scenes.abaco;
    const rollback = new Error('desfaz a transação do teste');
    const seen: { inside?: string; outside?: string } = {};
    await dataSource
      .transaction(async (manager) => {
        await manager.query(`UPDATE template_scenes SET name = 'Nome na transação' WHERE id = $1`, [
          scene.id,
        ]);
        seen.inside = (await snapshots.build(scene.id, manager)).name;
        seen.outside = (await snapshots.build(scene.id)).name;
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
    expect(seen).toEqual({ inside: 'Nome na transação', outside: scene.name });
    const [row] = await dataSource.query(`SELECT name FROM template_scenes WHERE id = $1`, [
      scene.id,
    ]);
    expect(row.name).toBe(scene.name);
  });
});
