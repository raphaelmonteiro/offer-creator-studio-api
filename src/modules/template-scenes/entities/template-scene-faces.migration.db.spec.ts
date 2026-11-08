import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { faceZones } from '../domain/scene-faces';
import { findSceneFormat } from '../domain/scene-formats';
import { describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { AddTemplateSceneFaces1767400000000 } from '../../../migrations/1767400000000-AddTemplateSceneFaces';

/**
 * A migration roda num schema temporário do banco descartável, sobre as três tabelas no formato de antes da change
 * (só as colunas que ela toca ou lê), com cenas que já existiam: com e sem versão, com e sem template, excluída e
 * de formato que saiu da lista. O `flyer_db` nunca é tocado.
 */
describeIfSceneDb('Cenas antigas viram uma face (migration, banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  const schema = `mig_faces_${process.pid}_${Date.now()}`;
  const migration = new AddTemplateSceneFaces1767400000000();

  const old = {
    withVersion: randomUUID(),
    plain: randomUUID(),
    deleted: randomUUID(),
    gone: randomUUID(),
  };
  const versionId = randomUUID();
  const templateId = randomUUID();

  beforeAll(async () => {
    dataSource = await openSceneTestDb();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.query(`CREATE SCHEMA "${schema}"`);
    await runner.query(`SET search_path TO "${schema}"`);
    await runner.query(`
      CREATE TABLE template_scenes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "formatId" varchar(64) NOT NULL,
        "widthPx" integer NOT NULL, "heightPx" integer NOT NULL,
        "currentVersionId" uuid, "approvedTemplateId" uuid, "deletedAt" timestamptz)`);
    await runner.query(`
      CREATE TABLE template_scene_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "sceneId" uuid NOT NULL REFERENCES template_scenes(id) ON DELETE CASCADE, "number" integer NOT NULL,
        status varchar(12) NOT NULL DEFAULT 'ready')`);
    await runner.query(`
      CREATE TABLE template_scene_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "sceneId" uuid NOT NULL, content text NOT NULL)`);
    await runner.query(
      `INSERT INTO template_scenes (id, "formatId", "widthPx", "heightPx", "currentVersionId", "approvedTemplateId", "deletedAt") VALUES
        ($1, 'folheto-20x27', 2480, 3328, $5, $6, NULL),
        ($2, 'folheto-27x54', 1920, 3840, NULL, NULL, NULL),
        ($3, 'folheto-27x40', 2352, 3504, NULL, NULL, now()),
        ($4, 'formato-que-saiu', 1000, 1000, NULL, NULL, NULL)`,
      [old.withVersion, old.plain, old.deleted, old.gone, versionId, templateId],
    );
    await runner.query(
      `INSERT INTO template_scene_versions (id, "sceneId", "number") VALUES ($1, $2, 1)`,
      [versionId, old.withVersion],
    );
    await runner.query(
      `INSERT INTO template_scene_messages ("sceneId", content) VALUES ($1, 'oi'), ($1, 'de novo')`,
      [old.withVersion],
    );
  });

  afterAll(async () => {
    await runner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await runner.query(`SET search_path TO public`);
    await runner.release();
    await dataSource.destroy();
  });

  const faces = () =>
    runner.query(`SELECT * FROM template_scene_faces ORDER BY "sceneId"`) as Promise<
      Array<Record<string, any>>
    >;
  const faceOf = async (sceneId: string) =>
    (await faces()).find((face) => face['sceneId'] === sceneId) as Record<string, any>;

  it('up: cada cena, inclusive a excluída, ganha uma face única com as zonas do formato e o espelho', async () => {
    await migration.up(runner);

    expect(await faces()).toHaveLength(4);
    const withVersion = await faceOf(old.withVersion);
    expect(withVersion).toMatchObject({
      index: 0,
      key: 'single',
      label: null,
      widthPx: 2480,
      heightPx: 3328,
      currentVersionId: versionId,
      templateId,
    });
    expect(withVersion['zones']).toEqual(
      faceZones(findSceneFormat('folheto-20x27') as never, 'single'),
    );
    const plain = await faceOf(old.plain);
    expect(plain).toMatchObject({ currentVersionId: null, templateId: null, key: 'single' });
    expect(plain['zones'].header.h).toBeCloseTo(6 / 54, 8);
    expect(await faceOf(old.deleted)).toMatchObject({ index: 0, key: 'single' });
    // formato que saiu da lista: o miolo inteiro, como `sceneZonesFor`
    expect((await faceOf(old.gone))['zones']).toEqual({
      header: { x: 0, y: 0, w: 1, h: 0 },
      body: { x: 0, y: 0, w: 1, h: 1 },
      footer: { x: 0, y: 1, w: 1, h: 0 },
    });
  });

  it('as cenas viram single, e versões e mensagens ficam na face 0; a cena segue com os ponteiros de antes', async () => {
    const scenes = await runner.query(
      `SELECT id, layout, "currentVersionId", "approvedTemplateId" FROM template_scenes`,
    );
    expect(scenes.every((scene: { layout: string }) => scene.layout === 'single')).toBe(true);
    const kept = scenes.find((scene: { id: string }) => scene.id === old.withVersion);
    expect(kept).toMatchObject({ currentVersionId: versionId, approvedTemplateId: templateId });
    const versions = await runner.query(
      `SELECT "faceIndex", "derivedFromVersionId" FROM template_scene_versions`,
    );
    expect(versions).toEqual([{ faceIndex: 0, derivedFromVersionId: null }]);
    const messages = await runner.query(`SELECT "faceIndex" FROM template_scene_messages`);
    expect(messages).toEqual([{ faceIndex: 0 }, { faceIndex: 0 }]);
  });

  it('up de novo não duplica nem sobrescreve (idempotente)', async () => {
    await runner.query(`UPDATE template_scene_faces SET "templateId" = NULL WHERE "sceneId" = $1`, [
      old.withVersion,
    ]);
    await migration.up(runner);
    expect(await faces()).toHaveLength(4);
    expect((await faceOf(old.withVersion))['templateId']).toBeNull();
  });

  it('down apaga a tabela e as colunas, e up de novo refaz o backfill sem erro', async () => {
    await migration.down(runner);
    const tables = await runner.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'template_scene_faces'`,
      [schema],
    );
    expect(tables).toEqual([]);
    const columns = await runner.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND column_name IN ('layout', 'faceIndex', 'derivedFromVersionId')`,
      [schema],
    );
    expect(columns).toEqual([]);

    await migration.up(runner);

    expect(await faces()).toHaveLength(4);
    expect((await faceOf(old.withVersion))['templateId']).toBe(templateId);
  });
});
