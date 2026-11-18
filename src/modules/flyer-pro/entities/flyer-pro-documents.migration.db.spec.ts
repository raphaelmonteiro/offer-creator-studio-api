import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateFlyerProDocuments1767700000000 } from '../../../migrations/1767700000000-CreateFlyerProDocuments';
import { createTempE2eDb } from '../../../shared/testing/e2e-temp-db.testutil';
import { describeIfE2eDb, openE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  catalogOf,
  MIGRATION_INDEXES,
  MIGRATION_TABLES,
  MINIMAL_CLIENTS_SQL,
} from './flyer-pro-documents.catalog.testutil';
import {
  createOtherTables,
  Exec,
  indexesIn,
  insertDocumentRow,
  othersOf,
  TABLES_OF_OTHERS,
  tablesIn,
} from './flyer-pro-documents.migration.testutil';

/**
 * A M1 roda num schema temporário do `chroma_x_e2e`, com uma `clients` mínima e `flyers` e `flyer_builder_v2_documents`
 * mínimas com uma linha cada. O cenário da extensão roda num banco `_e2e` novo (no `chroma_x_e2e` a `unaccent` já
 * existe). O `flyer_db` nunca é tocado.
 */
describeIfE2eDb('M1 do encarte (migration, schema temporário do banco de e2e)', () => {
  jest.setTimeout(120_000);
  let dataSource: DataSource;
  let runner: QueryRunner;
  const schema = `mig_flyer_pro_${process.pid}_${Date.now()}`;
  const migration = new CreateFlyerProDocuments1767700000000();
  const clientId = randomUUID();

  const exec: Exec = (sql: string, params?: unknown[]) => runner.query(sql, params);
  const tables = () => tablesIn(exec, schema);
  const indexes = () => indexesIn(exec, schema);
  const insertDocument = (id: string, extra: Record<string, unknown> = {}) =>
    insertDocumentRow(exec, clientId, id, extra);
  const othersNow = () => othersOf(exec, schema);

  beforeAll(async () => {
    dataSource = await openE2eDb();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await exec(`CREATE SCHEMA "${schema}"`);
    await exec(`SET search_path TO "${schema}"`);
    await exec(MINIMAL_CLIENTS_SQL);
    await exec(`INSERT INTO clients (id, name) VALUES ($1, 'Piccin')`, [clientId]);
    await createOtherTables(exec);
  });

  afterAll(async () => {
    await exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await exec(`SET search_path TO public`);
    await runner.release();
    await dataSource.destroy();
  });

  let firstUp: Awaited<ReturnType<typeof catalogOf>>;
  let othersBefore: Awaited<ReturnType<typeof othersOf>>;

  it('sobe: duas tabelas com 28 e 23 colunas, quatro chaves e seis índices, sem nada das migrations seguintes', async () => {
    othersBefore = await othersNow();
    await migration.up(runner);
    firstUp = await catalogOf(runner, schema);

    expect(await tables()).toEqual(['clients', ...TABLES_OF_OTHERS, ...MIGRATION_TABLES].sort());
    const count = (table: string) =>
      firstUp.columns.filter((c) => c.startsWith(`${table}.`)).length;
    expect(count('flyer_pro_documents')).toBe(28);
    expect(count('flyer_pro_items')).toBe(23);
    expect(firstUp.constraints).toEqual({
      PK_flyer_pro_documents: 'PRIMARY KEY (id)',
      FK_flyer_pro_documents_client:
        'FOREIGN KEY ("clientId") REFERENCES clients(id) ON DELETE RESTRICT',
      PK_flyer_pro_items: 'PRIMARY KEY (id)',
      FK_flyer_pro_items_document:
        'FOREIGN KEY ("documentId") REFERENCES flyer_pro_documents(id) ON DELETE CASCADE',
    });
    expect(
      Object.keys(firstUp.indexes)
        .filter((n) => MIGRATION_INDEXES.includes(n))
        .sort(),
    ).toEqual([...MIGRATION_INDEXES].sort());
    expect(firstUp.indexes['IDX_flyer_pro_documents_list']).toContain(
      '("updatedAt") WHERE ("deletedAt" IS NULL)',
    );
    expect(firstUp.indexes['IDX_flyer_pro_documents_client']).toMatch(
      /\("clientId", "updatedAt"\)$/,
    );
    expect(firstUp.indexes['UQ_flyer_pro_documents_creation_key']).toContain(
      'CREATE UNIQUE INDEX "UQ_flyer_pro_documents_creation_key"',
    );
    expect(firstUp.indexes['UQ_flyer_pro_documents_creation_key']).toContain(
      'WHERE ("creationKey" IS NOT NULL)',
    );
    expect(firstUp.indexes['IDX_flyer_pro_items_gallery_image']).toContain(
      'WHERE ("galleryImageId" IS NOT NULL)',
    );
    expect(firstUp.indexes['IDX_flyer_pro_items_document_position']).toMatch(
      /\("documentId", "position"\)$/,
    );
    expect(firstUp.indexes['IDX_flyer_pro_items_document_updated']).toMatch(
      /\("documentId", "updatedAt"\)$/,
    );
    const [{ n }] = await exec(
      `SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'unaccent'`,
    );
    expect(n).toBe(1);
  });

  it('o que não nasce na M1: importações, job, exportações, importId, thumbnailUrl e CHECK; flyers e v2 iguais', async () => {
    const all = await tables();
    for (const absent of ['flyer_pro_imports', 'flyer_pro_jobs', 'flyer_pro_exports']) {
      expect(all).not.toContain(absent);
    }
    expect(firstUp.columns.filter((c) => /\.(importId|thumbnailUrl):/.test(c))).toEqual([]);
    expect(Object.values(firstUp.constraints).filter((d) => d.startsWith('CHECK'))).toEqual([]);
    expect(await othersNow()).toEqual(othersBefore);
  });

  it('padrões das colunas: encarte e item inseridos só com o obrigatório', async () => {
    const id = randomUUID();
    await insertDocument(id);
    const [doc] = await exec(`SELECT * FROM flyer_pro_documents WHERE id = $1`, [id]);
    expect(doc).toMatchObject({
      pagesFrozen: false,
      step: 'products',
      ui: {},
      frame: {},
      structure: {},
      card: {},
      assembly: {},
      exportPrefs: {},
      schemaVersion: 1,
      revision: 0,
      layoutSnapshot: null,
      layoutDigest: null,
      renderDigest: null,
      lastMutationId: null,
      creationKey: null,
      createdByUserId: null,
      updatedByUserId: null,
      deletedAt: null,
    });
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
    await exec(
      `INSERT INTO flyer_pro_items (id, "documentId", position, name, price, unit) VALUES ($1, $2, 0, 'ABACATE', '{"kind":"simple","cents":699}', 'kg')`,
      [randomUUID(), id],
    );
    const [item] = await exec(`SELECT * FROM flyer_pro_items WHERE "documentId" = $1`, [id]);
    expect(item).toMatchObject({ isAlcoholic: false, imageStatus: 'none', ean: null });
  });

  it('item sem id: o banco recusa, porque a chave não tem padrão', async () => {
    const id = randomUUID();
    await insertDocument(id);
    await expect(
      exec(
        `INSERT INTO flyer_pro_items ("documentId", position, name, price, unit) VALUES ($1, 0, 'X', '{}', 'kg')`,
        [id],
      ),
    ).rejects.toThrow(/null value in column "id"/);
  });

  it('referências sem chave estrangeira: cena, autores e foto que não existem passam', async () => {
    const id = randomUUID();
    await insertDocument(id, { createdByUserId: randomUUID(), updatedByUserId: randomUUID() });
    await exec(
      `INSERT INTO flyer_pro_items (id, "documentId", position, name, price, unit, "galleryImageId") VALUES ($1, $2, 0, 'X', '{}', 'kg', $3)`,
      [randomUUID(), id, randomUUID()],
    );
    const [{ n }] = await exec(
      `SELECT count(*)::int AS n FROM flyer_pro_items WHERE "documentId" = $1`,
      [id],
    );
    expect(n).toBe(1);
  });

  it('sobe de novo com um encarte gravado: sem erro, nada muda, o encarte continua lá', async () => {
    const before = await exec(`SELECT count(*)::int AS n FROM flyer_pro_documents`);
    await migration.up(runner);
    expect(await catalogOf(runner, schema)).toEqual(firstUp);
    expect(await exec(`SELECT count(*)::int AS n FROM flyer_pro_documents`)).toEqual(before);
    expect(before[0].n).toBeGreaterThan(0);
  });

  it('desce: as duas tabelas e os seis índices somem, a extensão unaccent fica; sobe de novo igual', async () => {
    await migration.down(runner);
    expect(await tables()).toEqual(['clients', ...TABLES_OF_OTHERS].sort());
    const left = await indexes();
    for (const name of MIGRATION_INDEXES) expect(left).not.toContain(name);
    const [{ n }] = await exec(
      `SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'unaccent'`,
    );
    expect(n).toBe(1);

    await migration.up(runner);

    expect(await catalogOf(runner, schema)).toEqual(firstUp);
  });

  it('banco sem as tabelas e sem a extensão: a M1 cria a unaccent', async () => {
    const temp = await createTempE2eDb();
    const other = await new DataSource({ type: 'postgres', url: temp.url }).initialize();
    const bare = other.createQueryRunner();
    try {
      await bare.connect();
      await bare.query(MINIMAL_CLIENTS_SQL);
      const extension = `SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'unaccent'`;
      expect((await bare.query(extension))[0].n).toBe(0);

      await migration.up(bare);

      expect((await bare.query(extension))[0].n).toBe(1);
      const created = await catalogOf(bare, 'public');
      expect(Object.keys(created.constraints)).toHaveLength(4);
    } finally {
      await bare.release();
      await other.destroy();
      await temp.drop();
    }
  });
});
