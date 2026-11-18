import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateFlyerProDocuments1767700000000 } from '../../../migrations/1767700000000-CreateFlyerProDocuments';
import { CreateFlyerProImports1767800000000 } from '../../../migrations/1767800000000-CreateFlyerProImports';
import { describeIfE2eDb, openE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  ALL_TABLES,
  catalogOf,
  M2_INDEXES,
  MIGRATION_INDEXES,
  MINIMAL_CLIENTS_SQL,
} from './flyer-pro-documents.catalog.testutil';
import {
  createOtherTables,
  Exec,
  indexesIn,
  insertDocumentRow,
  insertItemRow,
  othersOf,
  TABLES_OF_OTHERS,
  tablesIn,
} from './flyer-pro-documents.migration.testutil';

const IMPORT_COLUMNS = [
  'id',
  'documentId',
  'fileName',
  'fileKind',
  'fileHash',
  'detectedFormat',
  'mode',
  'rowCount',
  'acceptedCount',
  'rejected',
  'createdByUserId',
  'createdAt',
];

type Catalog = Awaited<ReturnType<typeof catalogOf>>;

/**
 * A M2 roda num schema temporário do `chroma_x_e2e`, depois da M1, com um encarte e 3 itens já gravados. O `public` do
 * banco de e2e é montado pelas entidades e já tem a `FK_flyer_pro_items_import`: é o caso que o `up` tem de
 * atravessar. O `flyer_db` nunca é tocado.
 */
describeIfE2eDb('M2 das importações (migration, schema temporário do banco de e2e)', () => {
  jest.setTimeout(120_000);
  let dataSource: DataSource;
  let runner: QueryRunner;
  const schema = `mig_flyer_pro_imports_${process.pid}_${Date.now()}`;
  const m1 = new CreateFlyerProDocuments1767700000000();
  const m2 = new CreateFlyerProImports1767800000000();
  const clientId = randomUUID();
  const documentId = randomUUID();

  const exec: Exec = (sql: string, params?: unknown[]) => runner.query(sql, params);
  const catalog = () => catalogOf(runner, schema, ALL_TABLES);
  const itemsNow = () => exec(`SELECT * FROM flyer_pro_items ORDER BY position`);
  const insertImportRow = (id: string) =>
    exec(
      `INSERT INTO flyer_pro_imports (id, "documentId", "fileName", "fileKind", "fileHash", mode, "rowCount", "acceptedCount")
       VALUES ($1, $2, 'lista-piccin.csv', 'csv', '9f2c1a7b3d4e5f60', 'append', 5, 4)`,
      [id, documentId],
    );
  /** Cada FK de `importId` do banco, com o schema da tabela e o da tabela apontada. */
  const importForeignKeys = () =>
    exec(
      `SELECT n.nspname AS "schema", nt.nspname AS "targetSchema", tt.relname AS target,
              pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_class tt ON tt.oid = c.confrelid JOIN pg_namespace nt ON nt.oid = tt.relnamespace
        WHERE c.conname = 'FK_flyer_pro_items_import' AND t.relname = 'flyer_pro_items'
        ORDER BY 1`,
    );

  beforeAll(async () => {
    dataSource = await openE2eDb();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await exec(`CREATE SCHEMA "${schema}"`);
    await exec(`SET search_path TO "${schema}"`);
    await exec(MINIMAL_CLIENTS_SQL);
    await exec(`INSERT INTO clients (id, name) VALUES ($1, 'Piccin')`, [clientId]);
    await createOtherTables(exec);
    await m1.up(runner);
    await insertDocumentRow(exec, clientId, documentId);
    for (const position of [0, 1, 2]) await insertItemRow(exec, documentId, position);
  });

  afterAll(async () => {
    await exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await exec(`SET search_path TO public`);
    await runner.release();
    await dataSource.destroy();
  });

  let beforeM2: Catalog;
  let itemsBefore: unknown[];
  let othersBefore: Awaited<ReturnType<typeof othersOf>>;
  let publicForeignKeys: unknown[];
  let firstUp: Catalog;

  it('sobe com o encarte e 3 itens já gravados: tabela de 12 colunas, importId, as chaves e os índices; os itens iguais', async () => {
    beforeM2 = await catalogOf(runner, schema);
    itemsBefore = await itemsNow();
    othersBefore = await othersOf(exec, schema);
    publicForeignKeys = (await importForeignKeys()).filter((fk) => fk.schema === 'public');
    expect(publicForeignKeys).toHaveLength(1);

    await m2.up(runner);
    firstUp = await catalog();

    const importColumns = firstUp.columns.filter((c) => c.startsWith('flyer_pro_imports.'));
    expect(importColumns.map((c) => c.split(':')[0].split('.')[1]).sort()).toEqual(
      [...IMPORT_COLUMNS].sort(),
    );
    expect(firstUp.columns).toContain('flyer_pro_items.importId: uuid null');
    expect(firstUp.constraints).toMatchObject({
      PK_flyer_pro_imports: 'PRIMARY KEY (id)',
      FK_flyer_pro_imports_document:
        'FOREIGN KEY ("documentId") REFERENCES flyer_pro_documents(id) ON DELETE CASCADE',
      FK_flyer_pro_items_import:
        'FOREIGN KEY ("importId") REFERENCES flyer_pro_imports(id) ON DELETE SET NULL',
    });
    expect(firstUp.indexes['IDX_flyer_pro_imports_document_hash']).toMatch(
      /\("documentId", "fileHash"\)$/,
    );
    expect(firstUp.indexes['IDX_flyer_pro_items_import']).toMatch(
      /\("importId"\) WHERE \("importId" IS NOT NULL\)$/,
    );
    expect(await itemsNow()).toEqual(
      itemsBefore.map((item) => ({ ...(item as object), importId: null })),
    );
  });

  it('FK de mesmo nome em outro schema: a do schema novo existe e aponta para a tabela dele; a do public fica como estava', async () => {
    const keys = await importForeignKeys();

    expect(keys.filter((fk) => fk.schema === 'public')).toEqual(publicForeignKeys);
    expect(keys.find((fk) => fk.schema === schema)).toMatchObject({
      targetSchema: schema,
      target: 'flyer_pro_imports',
      definition: 'FOREIGN KEY ("importId") REFERENCES flyer_pro_imports(id) ON DELETE SET NULL',
    });
  });

  it('padrões das colunas: rejected [], createdAt preenchido, formato e autor nulos', async () => {
    const id = randomUUID();
    await insertImportRow(id);

    const [row] = await exec(`SELECT * FROM flyer_pro_imports WHERE id = $1`, [id]);

    expect(row).toMatchObject({ rejected: [], detectedFormat: null, createdByUserId: null });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('importação sem id: o banco recusa, porque a chave não tem padrão', async () => {
    await expect(
      exec(
        `INSERT INTO flyer_pro_imports ("documentId", "fileName", "fileKind", "fileHash", mode, "rowCount", "acceptedCount")
         VALUES ($1, 'x.csv', 'csv', 'h', 'append', 1, 1)`,
        [documentId],
      ),
    ).rejects.toThrow(/null value in column "id"/);
  });

  it('o que a M2 não toca: sem job nem exportações; encarte, flyers e v2 iguais', async () => {
    const all = await tablesIn(exec, schema);
    for (const absent of ['flyer_pro_jobs', 'flyer_pro_exports']) expect(all).not.toContain(absent);
    expect(all).toEqual(['clients', ...TABLES_OF_OTHERS, ...ALL_TABLES].sort());
    const documents = (rows: string[]) => rows.filter((c) => c.startsWith('flyer_pro_documents.'));
    expect(documents(firstUp.columns)).toEqual(documents(beforeM2.columns));
    expect(await othersOf(exec, schema)).toEqual(othersBefore);
  });

  it('sobe de novo com uma importação e um item ligado: sem erro, nada muda', async () => {
    const id = randomUUID();
    await insertImportRow(id);
    await exec(
      `UPDATE flyer_pro_items SET "importId" = $1 WHERE position = 0 AND "documentId" = $2`,
      [id, documentId],
    );
    const imports = () => exec(`SELECT * FROM flyer_pro_imports ORDER BY id`);
    const importsBefore = await imports();
    const itemsLinked = await itemsNow();

    await m2.up(runner);

    expect(await catalog()).toEqual(firstUp);
    expect(await imports()).toEqual(importsBefore);
    expect(await itemsNow()).toEqual(itemsLinked);
    expect(itemsLinked[0].importId).toBe(id);
  });

  it('desce: a tabela, importId, a FK e os dois índices somem, e a M1 fica íntegra', async () => {
    const itemsLinked = await itemsNow();

    await m2.down(runner);

    expect(await tablesIn(exec, schema)).toEqual(
      ['clients', ...TABLES_OF_OTHERS, 'flyer_pro_documents', 'flyer_pro_items'].sort(),
    );
    const left = await indexesIn(exec, schema);
    for (const name of M2_INDEXES) expect(left).not.toContain(name);
    for (const name of MIGRATION_INDEXES) expect(left).toContain(name);
    const afterDown = await catalogOf(runner, schema);
    expect(afterDown).toEqual(beforeM2);
    expect(afterDown.columns.some((c) => c.includes('importId'))).toBe(false);
    expect(Object.keys(afterDown.constraints)).toHaveLength(4);
    const [{ n }] = await exec(`SELECT count(*)::int AS n FROM flyer_pro_documents`);
    expect(n).toBe(1);
    const withoutImportId = (items: Array<Record<string, unknown>>) =>
      items.map((item) =>
        Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'importId')),
      );
    expect(await itemsNow()).toEqual(withoutImportId(itemsLinked));
  });

  it('sobe de novo depois de descer: tudo igual à primeira subida', async () => {
    await m2.up(runner);

    expect(await catalog()).toEqual(firstUp);
  });
});
