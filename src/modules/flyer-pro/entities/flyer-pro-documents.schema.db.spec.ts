import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateFlyerProDocuments1767700000000 } from '../../../migrations/1767700000000-CreateFlyerProDocuments';
import { CreateFlyerProImports1767800000000 } from '../../../migrations/1767800000000-CreateFlyerProImports';
import { describeIfE2eDb, openE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  insertClient,
  insertDocument,
  insertDocumentWithItems,
  insertItems,
  purgeDocumentsOf,
} from '../testing/flyer-pro-documents.fixture';
import { insertImport } from '../testing/flyer-pro-imports.fixture';
import { ALL_TABLES, catalogOf, MINIMAL_CLIENTS_SQL } from './flyer-pro-documents.catalog.testutil';

/**
 * O banco de e2e é montado pelo `synchronize` das entidades. Aqui as entidades são comparadas com o que a M1 e a M2
 * criam (catálogo do Postgres) e as garantias de integridade das tabelas são provadas nele. Limpa só o que criou, encartes
 * antes dos clientes.
 */
describeIfE2eDb('Entidades do encarte e integridade (banco montado pelas entidades)', () => {
  jest.setTimeout(120_000);
  let dataSource: DataSource;
  const clientIds: string[] = [];

  const newClient = async (): Promise<string> => {
    const id = await insertClient(dataSource, 'Cliente schema');
    clientIds.push(id);
    return id;
  };
  const deleteClient = (id: string) => dataSource.query(`DELETE FROM clients WHERE id = $1`, [id]);
  const count = async (sql: string, id: string): Promise<number> =>
    (await dataSource.query(sql, [id]))[0].n;
  const documentsOf = (clientId: string) =>
    count(`SELECT count(*)::int AS n FROM flyer_pro_documents WHERE "clientId" = $1`, clientId);

  beforeAll(async () => {
    dataSource = await openE2eDb();
  });

  afterAll(async () => {
    await purgeDocumentsOf(dataSource, clientIds);
    await dataSource.query(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [clientIds]);
    await dataSource.destroy();
  });

  it('nomes, colunas, unicidade, filtros dos índices e regras ON DELETE iguais aos da M1 e da M2', async () => {
    const schema = `mig_flyer_pro_schema_${process.pid}_${Date.now()}`;
    const runner: QueryRunner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET search_path TO "${schema}"`);
      await runner.query(MINIMAL_CLIENTS_SQL);
      await new CreateFlyerProDocuments1767700000000().up(runner);
      await new CreateFlyerProImports1767800000000().up(runner);
      const fromMigrations = await catalogOf(runner, schema, ALL_TABLES);
      await runner.query(`SET search_path TO public`);

      expect(await catalogOf(dataSource, 'public', ALL_TABLES)).toEqual(fromMigrations);
    } finally {
      await runner.query(`SET search_path TO public`);
      await runner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await runner.release();
    }
  });

  describe('cliente com encarte não pode ser apagado', () => {
    it('com encarte vivo, o banco recusa pela FK e nada sai', async () => {
      const clientId = await newClient();
      await insertDocument(dataSource, { clientId });

      await expect(deleteClient(clientId)).rejects.toThrow(/FK_flyer_pro_documents_client/);

      expect(await count(`SELECT count(*)::int AS n FROM clients WHERE id = $1`, clientId)).toBe(1);
      expect(await documentsOf(clientId)).toBe(1);
    });

    it('só com encarte excluído logicamente, o banco recusa do mesmo jeito', async () => {
      const clientId = await newClient();
      await insertDocument(dataSource, { clientId, deletedAt: new Date() });

      await expect(deleteClient(clientId)).rejects.toThrow(/FK_flyer_pro_documents_client/);

      expect(await documentsOf(clientId)).toBe(1);
    });

    it('sem encarte, o cliente sai sem erro', async () => {
      const clientId = await newClient();
      await deleteClient(clientId);
      expect(await count(`SELECT count(*)::int AS n FROM clients WHERE id = $1`, clientId)).toBe(0);
    });
  });

  describe('itens presos a um encarte', () => {
    it('item de encarte que não existe: o banco recusa pela FK do item', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO flyer_pro_items (id, "documentId", position, name, price, unit) VALUES ($1, $2, 0, 'X', '{}', 'kg')`,
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toThrow(/FK_flyer_pro_items_document/);
    });

    it('apagar o encarte fisicamente leva os 3 itens', async () => {
      const clientId = await newClient();
      const { id } = await insertDocumentWithItems(dataSource, { clientId }, 3);
      const items = `SELECT count(*)::int AS n FROM flyer_pro_items WHERE "documentId" = $1`;
      expect(await count(items, id)).toBe(3);

      await dataSource.query(`DELETE FROM flyer_pro_documents WHERE id = $1`, [id]);

      expect(await count(items, id)).toBe(0);
    });
  });

  describe('importações presas ao encarte', () => {
    const importsOf = (id: string) =>
      count(`SELECT count(*)::int AS n FROM flyer_pro_imports WHERE "documentId" = $1`, id);
    const itemsOf = (id: string) =>
      count(`SELECT count(*)::int AS n FROM flyer_pro_items WHERE "documentId" = $1`, id);

    it('importação de encarte que não existe: o banco recusa pela FK da importação', async () => {
      await expect(insertImport(dataSource, randomUUID())).rejects.toThrow(
        /FK_flyer_pro_imports_document/,
      );
    });

    it('apagar fisicamente um encarte excluído logicamente leva as 2 importações e os 4 itens, sem erro de FK', async () => {
      const clientId = await newClient();
      const id = await insertDocument(dataSource, { clientId, deletedAt: new Date() });
      const [first, second] = [
        await insertImport(dataSource, id),
        await insertImport(dataSource, id),
      ];
      await insertItems(dataSource, id, [
        { importId: first },
        { importId: first },
        { importId: second },
        { importId: second },
      ]);
      expect([await importsOf(id), await itemsOf(id)]).toEqual([2, 4]);

      await dataSource.query(`DELETE FROM flyer_pro_documents WHERE id = $1`, [id]);

      expect([await importsOf(id), await itemsOf(id)]).toEqual([0, 0]);
    });

    it('importação apagada direto: os 4 itens continuam, com importId nulo', async () => {
      const clientId = await newClient();
      const id = await insertDocument(dataSource, { clientId });
      const importId = await insertImport(dataSource, id);
      await insertItems(
        dataSource,
        id,
        Array.from({ length: 4 }, () => ({ importId })),
      );

      await dataSource.query(`DELETE FROM flyer_pro_imports WHERE id = $1`, [importId]);

      expect(await itemsOf(id)).toBe(4);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM flyer_pro_items WHERE "documentId" = $1 AND "importId" IS NULL`,
          id,
        ),
      ).toBe(4);
    });
  });

  describe('chave de criação única', () => {
    it('a mesma chave duas vezes: o banco recusa pelo índice único', async () => {
      const clientId = await newClient();
      const creationKey = randomUUID();
      await insertDocument(dataSource, { clientId, creationKey });

      await expect(insertDocument(dataSource, { clientId, creationKey })).rejects.toThrow(
        /UQ_flyer_pro_documents_creation_key/,
      );
    });

    it('a chave de um encarte excluído logicamente continua tomada', async () => {
      const clientId = await newClient();
      const creationKey = randomUUID();
      await insertDocument(dataSource, { clientId, creationKey, deletedAt: new Date() });

      await expect(insertDocument(dataSource, { clientId, creationKey })).rejects.toThrow(
        /UQ_flyer_pro_documents_creation_key/,
      );
    });

    it('dois encartes com chave nula convivem', async () => {
      const clientId = await newClient();
      await insertDocument(dataSource, { clientId, creationKey: null });
      await insertDocument(dataSource, { clientId, creationKey: null });
      expect(await documentsOf(clientId)).toBe(2);
    });
  });
});
