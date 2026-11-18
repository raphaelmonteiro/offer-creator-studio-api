import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateFlyerProDocuments1767700000000 } from '../../../migrations/1767700000000-CreateFlyerProDocuments';
import { CreateFlyerProExports1768000000000 } from '../../../migrations/1768000000000-CreateFlyerProExports';
import { describeIfE2eDb, openE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  catalogOf,
  M4_INDEXES,
  M4_TABLES,
  MIGRATION_INDEXES,
  MIGRATION_TABLES,
  MINIMAL_CLIENTS_SQL,
} from './flyer-pro-documents.catalog.testutil';
import {
  createOtherTables,
  Exec,
  indexesIn,
  insertDocumentRow,
  insertExportRow,
  insertItemRow,
  othersOf,
  TABLES_OF_OTHERS,
  tablesIn,
} from './flyer-pro-documents.migration.testutil';

/** As 14 colunas da M4 como o catálogo as descreve (ordenadas na comparação, para não depender da ordenação do banco). */
const EXPORT_COLUMNS = [
  'flyer_pro_exports.createdAt: timestamp with time zone not null default now()',
  'flyer_pro_exports.createdByUserId: uuid null',
  'flyer_pro_exports.documentId: uuid not null',
  'flyer_pro_exports.documentRevision: integer not null',
  'flyer_pro_exports.engineVersion: integer not null',
  'flyer_pro_exports.fileName: character varying(200) not null',
  'flyer_pro_exports.filePath: character varying(500) null',
  'flyer_pro_exports.fileSize: bigint null',
  "flyer_pro_exports.fileState: character varying(16) not null default 'not_stored'::character varying",
  'flyer_pro_exports.format: character varying(8) not null',
  'flyer_pro_exports.id: uuid not null',
  "flyer_pro_exports.options: jsonb not null default '{}'::jsonb",
  'flyer_pro_exports.preflight: jsonb null',
  'flyer_pro_exports.renderDigest: character varying(64) null',
];

type Catalog = Awaited<ReturnType<typeof catalogOf>>;

/**
 * A M4 roda num schema temporário do `chroma_x_e2e`, depois da M1 (a única de que depende), com um encarte e 3 itens já
 * gravados. O `public` do banco de e2e é montado pelas entidades e já tem `flyer_pro_exports`: o schema temporário
 * isola a migration dele. O `flyer_db` nunca é tocado.
 */
describeIfE2eDb('M4 das exportações (migration, schema temporário do banco de e2e)', () => {
  jest.setTimeout(120_000);
  let dataSource: DataSource;
  let runner: QueryRunner;
  const schema = `mig_flyer_pro_exports_${process.pid}_${Date.now()}`;
  const m1 = new CreateFlyerProDocuments1767700000000();
  const m4 = new CreateFlyerProExports1768000000000();
  const clientId = randomUUID();
  const documentId = randomUUID();

  const exec: Exec = (sql: string, params?: unknown[]) => runner.query(sql, params);
  const catalog = () => catalogOf(runner, schema, [...MIGRATION_TABLES, ...M4_TABLES]);
  const exportsCatalog = () => catalogOf(runner, schema, M4_TABLES);
  const itemsNow = () => exec(`SELECT * FROM flyer_pro_items ORDER BY position`);
  const documentsNow = () => exec(`SELECT * FROM flyer_pro_documents`);
  const exportsNow = () => exec(`SELECT * FROM flyer_pro_exports ORDER BY id`);

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

  let beforeM4: Catalog;
  let documentsBefore: unknown[];
  let itemsBefore: unknown[];
  let othersBefore: Awaited<ReturnType<typeof othersOf>>;
  let firstUp: Catalog;

  it('sobe com o encarte e 3 itens já gravados: a tabela de 14 colunas, as duas chaves e o índice', async () => {
    beforeM4 = await catalogOf(runner, schema);
    documentsBefore = await documentsNow();
    itemsBefore = await itemsNow();
    othersBefore = await othersOf(exec, schema);
    expect(await tablesIn(exec, schema)).not.toContain('flyer_pro_exports');

    await m4.up(runner);
    firstUp = await catalog();

    const { columns, constraints, indexes } = await exportsCatalog();
    expect([...columns].sort()).toEqual([...EXPORT_COLUMNS].sort());
    expect(constraints).toEqual({
      PK_flyer_pro_exports: 'PRIMARY KEY (id)',
      FK_flyer_pro_exports_document:
        'FOREIGN KEY ("documentId") REFERENCES flyer_pro_documents(id) ON DELETE CASCADE',
    });
    expect(Object.keys(indexes).sort()).toEqual([
      'IDX_flyer_pro_exports_document_created',
      'PK_flyer_pro_exports',
    ]);
    expect(indexes['IDX_flyer_pro_exports_document_created']).toMatch(
      /\("documentId", "createdAt"\)$/,
    );
  });

  it('padrões das colunas: options {}, fileState not_stored, createdAt preenchido e o resto nulo', async () => {
    const id = randomUUID();
    await insertExportRow(exec, documentId, id);

    const [row] = await exec(`SELECT * FROM flyer_pro_exports WHERE id = $1`, [id]);

    expect(row).toMatchObject({
      options: {},
      fileState: 'not_stored',
      renderDigest: null,
      fileSize: null,
      preflight: null,
      filePath: null,
      createdByUserId: null,
    });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('exportação sem id: o banco recusa, porque a chave não tem padrão', async () => {
    await expect(
      exec(
        `INSERT INTO flyer_pro_exports ("documentId", "documentRevision", "engineVersion", format, "fileName")
         VALUES ($1, 3, 1, 'pdf', 'ofertas-piccin.pdf')`,
        [documentId],
      ),
    ).rejects.toThrow(/null value in column "id"/);
  });

  it('autor que não é de nenhum usuário: a inserção passa, porque createdByUserId não tem FK', async () => {
    const id = randomUUID();
    const author = randomUUID();

    await insertExportRow(exec, documentId, id, { createdByUserId: author });

    const [row] = await exec(`SELECT "createdByUserId" FROM flyer_pro_exports WHERE id = $1`, [id]);
    expect(row.createdByUserId).toBe(author);
  });

  it('o que a M4 não toca: sem CHECK na tabela; a M1 com as mesmas colunas, chaves, índices e linhas', async () => {
    const { constraints } = await exportsCatalog();
    expect(Object.values(constraints).filter((def) => def.startsWith('CHECK'))).toEqual([]);

    expect(await tablesIn(exec, schema)).toEqual(
      ['clients', ...TABLES_OF_OTHERS, ...MIGRATION_TABLES, ...M4_TABLES].sort(),
    );
    expect(await catalogOf(runner, schema)).toEqual(beforeM4);
    expect(await documentsNow()).toEqual(documentsBefore);
    expect(await itemsNow()).toEqual(itemsBefore);
    expect(await othersOf(exec, schema)).toEqual(othersBefore);
  });

  it('sobe de novo com uma exportação gravada: sem erro, a tabela, as chaves e o índice iguais e a linha lá', async () => {
    const id = randomUUID();
    await insertExportRow(exec, documentId, id, { fileSize: 31457280 });
    const exportsBefore = await exportsNow();

    await m4.up(runner);

    expect(await catalog()).toEqual(firstUp);
    expect(await exportsNow()).toEqual(exportsBefore);
    expect(exportsBefore.map((row) => row.id)).toContain(id);
  });

  it('desce com o encarte, os 3 itens e as exportações: só o índice e a tabela somem, e a M1 fica íntegra', async () => {
    await m4.down(runner);

    expect(await tablesIn(exec, schema)).toEqual(
      ['clients', ...TABLES_OF_OTHERS, ...MIGRATION_TABLES].sort(),
    );
    const left = await indexesIn(exec, schema);
    for (const name of M4_INDEXES) expect(left).not.toContain(name);
    for (const name of MIGRATION_INDEXES) expect(left).toContain(name);
    expect(await catalogOf(runner, schema)).toEqual(beforeM4);
    expect(await documentsNow()).toEqual(documentsBefore);
    expect(await itemsNow()).toEqual(itemsBefore);
    expect(itemsBefore).toHaveLength(3);
  });

  it('sobe de novo depois de descer: a tabela, as duas chaves e o índice como na primeira subida', async () => {
    await m4.up(runner);

    expect(await catalog()).toEqual(firstUp);
  });
});
