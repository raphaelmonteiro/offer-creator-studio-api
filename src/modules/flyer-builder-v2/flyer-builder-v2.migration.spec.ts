import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateFlyerBuilderV2Documents1766800000000 } from '../../migrations/1766800000000-CreateFlyerBuilderV2Documents';

const database = process.env.FLYER_V2_IT_DB_NAME;
const describeIf = database ? describe : describe.skip;

describeIf('Documentos V2 sem synchronize (Postgres descartável)', () => {
  const schema = `qa_flyer_v2_${randomUUID().replace(/-/g, '')}`;
  let ds: DataSource;
  let runner: QueryRunner;

  beforeAll(async () => {
    if (!database?.startsWith('chroma_qa_')) throw new Error('Use um banco chroma_qa_ descartável');
    ds = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port: Number(process.env.FLYER_V2_IT_DB_PORT),
      username: 'qa',
      password: 'chroma_qa_pass',
      database,
      synchronize: false,
    });
    await ds.initialize();
    runner = ds.createQueryRunner();
    await runner.connect();
    await runner.query(`CREATE SCHEMA "${schema}"`);
    await runner.query(`SET search_path TO "${schema}"`);
    await runner.query('CREATE TABLE clients (id uuid PRIMARY KEY)');
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await runner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await runner.release();
    await ds.destroy();
  });

  it('cria a tabela, preserva o EAN e a foto em JSONB, respeita o cliente e permite reverter', async () => {
    const migration = new CreateFlyerBuilderV2Documents1766800000000();
    await migration.up(runner);
    const document = { pages: [{ products: [{ ean: '7891000100103', imageUrl: '/photo.png' }] }] };
    const [saved] = await runner.query(
      `INSERT INTO flyer_builder_v2_documents (name, document) VALUES ($1, $2) RETURNING *`,
      ['Teste DotCompany', document],
    );
    expect(saved).toMatchObject({ status: 'draft', schemaVersion: 2, builder: 'flyer-builder-v2' });
    expect(saved.document).toEqual(document);
    expect(saved.createdAt).toBeInstanceOf(Date);
    await migration.up(runner);
    expect(await runner.query('SELECT id FROM flyer_builder_v2_documents')).toEqual([
      { id: saved.id },
    ]);
    await expect(
      runner.query(
        `INSERT INTO flyer_builder_v2_documents (name, "clientId", document) VALUES ($1, $2, $3)`,
        ['Cliente inexistente', randomUUID(), document],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await migration.down(runner);
    const [result] = await runner.query(
      `SELECT to_regclass('flyer_builder_v2_documents') AS table`,
    );
    expect(result.table).toBeNull();
    await migration.up(runner);
    expect(await runner.query('SELECT id FROM flyer_builder_v2_documents')).toEqual([]);
  });
});
