import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateFlyerProDocuments1767700000000 } from '../../../migrations/1767700000000-CreateFlyerProDocuments';
import { CreateFlyerProExports1768000000000 } from '../../../migrations/1768000000000-CreateFlyerProExports';
import { describeIfE2eDb, openE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  insertClient,
  insertDocument,
  insertItems,
  purgeDocumentsOf,
} from '../testing/flyer-pro-documents.fixture';
import { insertExport } from '../testing/flyer-pro-exports.fixture';
import { catalogOf, M4_TABLES, MINIMAL_CLIENTS_SQL } from './flyer-pro-documents.catalog.testutil';

/**
 * O banco de e2e é montado pelo `synchronize` das entidades. Aqui a entidade da exportação é comparada com o que a M4
 * cria (catálogo do Postgres) e as garantias de integridade da tabela são provadas nele. Arquivo próprio: o spec de
 * schema da M1 e da M2 é ampliado por outra change (A-2). Limpa só o que criou, encartes antes dos clientes.
 */
describeIfE2eDb('Entidade das exportações e integridade (banco montado pelas entidades)', () => {
  jest.setTimeout(120_000);
  let dataSource: DataSource;
  const clientIds: string[] = [];

  const count = async (sql: string, id: string): Promise<number> =>
    (await dataSource.query(sql, [id]))[0].n;
  const exportsOf = (id: string) =>
    count(`SELECT count(*)::int AS n FROM flyer_pro_exports WHERE "documentId" = $1`, id);
  const itemsOf = (id: string) =>
    count(`SELECT count(*)::int AS n FROM flyer_pro_items WHERE "documentId" = $1`, id);

  beforeAll(async () => {
    dataSource = await openE2eDb();
  });

  afterAll(async () => {
    await purgeDocumentsOf(dataSource, clientIds);
    await dataSource.query(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [clientIds]);
    await dataSource.destroy();
  });

  it('nomes, colunas, padrões, índice e regra ON DELETE CASCADE iguais aos da M4', async () => {
    const schema = `mig_flyer_pro_exports_schema_${process.pid}_${Date.now()}`;
    const runner: QueryRunner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET search_path TO "${schema}"`);
      await runner.query(MINIMAL_CLIENTS_SQL);
      await new CreateFlyerProDocuments1767700000000().up(runner);
      await new CreateFlyerProExports1768000000000().up(runner);
      const fromMigration = await catalogOf(runner, schema, M4_TABLES);
      await runner.query(`SET search_path TO public`);

      const fromEntity = await catalogOf(dataSource, 'public', M4_TABLES);

      expect(fromEntity).toEqual(fromMigration);
      expect(Object.keys(fromEntity.constraints).sort()).toEqual([
        'FK_flyer_pro_exports_document',
        'PK_flyer_pro_exports',
      ]);
      expect(fromEntity.constraints['FK_flyer_pro_exports_document']).toMatch(/ON DELETE CASCADE$/);
    } finally {
      await runner.query(`SET search_path TO public`);
      await runner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await runner.release();
    }
  });

  describe('exportações presas ao encarte', () => {
    const newDocument = async (over: { deletedAt?: Date } = {}): Promise<string> => {
      const clientId = await insertClient(dataSource, 'Cliente schema exportações');
      clientIds.push(clientId);
      return insertDocument(dataSource, { clientId, ...over });
    };

    it('exportação de encarte que não existe: o banco recusa pela FK da exportação', async () => {
      await expect(insertExport(dataSource, randomUUID())).rejects.toThrow(
        /FK_flyer_pro_exports_document/,
      );
    });

    it('apagar fisicamente um encarte excluído logicamente leva as 2 exportações e os 3 itens, sem erro de FK', async () => {
      const id = await newDocument({ deletedAt: new Date() });
      await insertExport(dataSource, id);
      await insertExport(dataSource, id, { fileSize: null, preflight: null });
      await insertItems(dataSource, id, [{}, {}, {}]);
      expect([await exportsOf(id), await itemsOf(id)]).toEqual([2, 3]);

      await dataSource.query(`DELETE FROM flyer_pro_documents WHERE id = $1`, [id]);

      expect([await exportsOf(id), await itemsOf(id)]).toEqual([0, 0]);
    });
  });
});
