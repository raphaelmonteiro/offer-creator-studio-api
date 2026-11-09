import { DataSource, QueryRunner } from 'typeorm';
import { describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { AddTemplateSceneVersionZones1767500000000 } from '../../../migrations/1767500000000-AddTemplateSceneVersionZones';

/**
 * A migration `zones` da versão roda num schema temporário do banco descartável, sobre uma tabela com linhas antigas:
 * up, down, up sem erro e sem mexer nas linhas existentes (nulo = zonas da criação).
 */
describeIfSceneDb('Zonas por versão (migration, banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  const schema = `mig_zones_${process.pid}_${Date.now()}`;
  const migration = new AddTemplateSceneVersionZones1767500000000();

  beforeAll(async () => {
    dataSource = await openSceneTestDb();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.query(`CREATE SCHEMA "${schema}"`);
    await runner.query(`SET search_path TO "${schema}"`);
    await runner.query(
      `CREATE TABLE template_scene_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "number" integer NOT NULL)`,
    );
    await runner.query(`INSERT INTO template_scene_versions ("number") VALUES (1), (2)`);
  });

  afterAll(async () => {
    await runner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await runner.query(`SET search_path TO public`);
    await runner.release();
    await dataSource.destroy();
  });

  const hasColumn = async (): Promise<boolean> =>
    (
      await runner.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'template_scene_versions' AND column_name = 'zones'`,
        [schema],
      )
    ).length > 0;

  it('up, down e up de novo sem erro; as linhas antigas ficam com zones nulo', async () => {
    await migration.up(runner);
    expect(await hasColumn()).toBe(true);
    const rows = await runner.query(`SELECT zones FROM template_scene_versions`);
    expect(rows).toEqual([{ zones: null }, { zones: null }]);
    await migration.down(runner);
    expect(await hasColumn()).toBe(false);
    await migration.up(runner);
    await migration.up(runner); // idempotente
    expect(await hasColumn()).toBe(true);
    expect(await runner.query(`SELECT 1 FROM template_scene_versions`)).toHaveLength(2);
  });
});
