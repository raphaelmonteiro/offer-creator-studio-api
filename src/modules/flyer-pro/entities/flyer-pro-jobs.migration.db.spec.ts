import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateFlyerProDocuments1767700000000 } from '../../../migrations/1767700000000-CreateFlyerProDocuments';
import { CreateFlyerProImports1767800000000 } from '../../../migrations/1767800000000-CreateFlyerProImports';
import { CreateFlyerProJobs1767900000000 } from '../../../migrations/1767900000000-CreateFlyerProJobs';
import { describeIfE2eDb, openE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  ALL_TABLES,
  catalogOf,
  M3_INDEXES,
  MINIMAL_CLIENTS_SQL,
  TABLES_AFTER_M3,
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

const JOB_COLUMNS = [
  'id',
  'documentId',
  'steps',
  'status',
  'phase',
  'cursor',
  'total',
  'processed',
  'itemIds',
  'onlyMissing',
  'autoApply',
  'result',
  'error',
  'models',
  'costUsd',
  'batchSeq',
  'batchAttempts',
  'heartbeatAt',
  'cancelRequestedAt',
  'createdByUserId',
  'createdAt',
  'updatedAt',
  'startedAt',
  'finishedAt',
];

/**
 * A M3 roda num schema temporário do `chroma_x_e2e`, depois da M1 e da M2, com um encarte, dois itens e uma importação
 * já gravados. O `flyer_db` nunca é tocado.
 */
describeIfE2eDb('M3 dos jobs (migration, schema temporário do banco de e2e)', () => {
  jest.setTimeout(120_000);
  let dataSource: DataSource;
  let runner: QueryRunner;
  const schema = `mig_flyer_pro_jobs_${process.pid}_${Date.now()}`;
  const m3 = new CreateFlyerProJobs1767900000000();
  const clientId = randomUUID();
  const documentId = randomUUID();

  const exec: Exec = (sql: string, params?: unknown[]) => runner.query(sql, params);
  const catalog = () => catalogOf(runner, schema, TABLES_AFTER_M3);
  const insertJob = (status: string, doc = documentId) =>
    exec(
      `INSERT INTO flyer_pro_jobs ("documentId", steps, status) VALUES ($1, '["image_match"]', $2) RETURNING *`,
      [doc, status],
    );
  const documentTables = async () => ({
    documents: await exec(`SELECT * FROM flyer_pro_documents`),
    items: await exec(`SELECT * FROM flyer_pro_items ORDER BY position`),
    imports: await exec(`SELECT * FROM flyer_pro_imports`),
  });

  beforeAll(async () => {
    dataSource = await openE2eDb();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await exec(`CREATE SCHEMA "${schema}"`);
    await exec(`SET search_path TO "${schema}"`);
    await exec(MINIMAL_CLIENTS_SQL);
    await exec(`INSERT INTO clients (id, name) VALUES ($1, 'Piccin')`, [clientId]);
    await createOtherTables(exec);
    await new CreateFlyerProDocuments1767700000000().up(runner);
    await new CreateFlyerProImports1767800000000().up(runner);
    await insertDocumentRow(exec, clientId, documentId);
    for (const position of [0, 1]) await insertItemRow(exec, documentId, position);
    await exec(
      `INSERT INTO flyer_pro_imports (id, "documentId", "fileName", "fileKind", "fileHash", mode, "rowCount", "acceptedCount")
       VALUES ($1, $2, 'lista-piccin.csv', 'csv', '9f2c1a7b3d4e5f60', 'append', 2, 2)`,
      [randomUUID(), documentId],
    );
  });

  afterAll(async () => {
    await exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await exec(`SET search_path TO public`);
    await runner.release();
    await dataSource.destroy();
  });

  let before: Awaited<ReturnType<typeof documentTables>>;
  let othersBefore: Awaited<ReturnType<typeof othersOf>>;
  let catalogBefore: Awaited<ReturnType<typeof catalogOf>>;
  let firstUp: Awaited<ReturnType<typeof catalogOf>>;

  it('sobe com encarte, itens e importação gravados: 24 colunas, a chave, a FK e os dois índices', async () => {
    before = await documentTables();
    othersBefore = await othersOf(exec, schema);
    catalogBefore = await catalogOf(runner, schema, ALL_TABLES);

    await m3.up(runner);
    firstUp = await catalog();

    const columns = firstUp.columns.filter((c) => c.startsWith('flyer_pro_jobs.'));
    expect(columns.map((c) => c.split(':')[0].split('.')[1]).sort()).toEqual(
      [...JOB_COLUMNS].sort(),
    );
    expect(firstUp.constraints).toMatchObject({
      PK_flyer_pro_jobs: 'PRIMARY KEY (id)',
      FK_flyer_pro_jobs_document:
        'FOREIGN KEY ("documentId") REFERENCES flyer_pro_documents(id) ON DELETE CASCADE',
    });
    expect(firstUp.indexes['UQ_flyer_pro_jobs_document_active']).toMatch(
      /UNIQUE INDEX .*\("documentId"\) WHERE \(\(status\)::text = ANY \(\(ARRAY\['queued'::character varying, 'running'::character varying\]\)::text\[\]\)\)$/,
    );
    expect(firstUp.indexes['IDX_flyer_pro_jobs_document_created']).toMatch(
      /\("documentId", "createdAt"\)$/,
    );
    expect(await documentTables()).toEqual(before);
  });

  it('job só com documentId e steps: os padrões do requisito e o resto nulo', async () => {
    const [job] = await exec(
      `INSERT INTO flyer_pro_jobs ("documentId", steps) VALUES ($1, '["image_match"]') RETURNING *`,
      [documentId],
    );

    expect(job).toMatchObject({
      status: 'queued',
      total: 0,
      processed: 0,
      batchSeq: 0,
      batchAttempts: 0,
      onlyMissing: true,
      autoApply: true,
      result: {},
      steps: ['image_match'],
      phase: null,
      cursor: null,
      itemIds: null,
      error: null,
      models: null,
      costUsd: null,
      heartbeatAt: null,
      cancelRequestedAt: null,
      createdByUserId: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(job.id).toEqual(expect.any(String));
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(job.updatedAt).toBeInstanceOf(Date);
    await exec(`DELETE FROM flyer_pro_jobs WHERE id = $1`, [job.id]);
  });

  it('job sem steps: o banco recusa por coluna obrigatória', async () => {
    await expect(
      exec(`INSERT INTO flyer_pro_jobs ("documentId") VALUES ($1)`, [documentId]),
    ).rejects.toThrow(/null value in column "steps"/);
  });

  it('segundo job ativo no mesmo encarte: 23505 do índice parcial; depois de terminados, outro entra', async () => {
    const [running] = await insertJob('running');

    await expect(insertJob('queued')).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_flyer_pro_jobs_document_active',
    });
    await exec(`UPDATE flyer_pro_jobs SET status = 'done' WHERE id = $1`, [running.id]);
    const [canceled] = await insertJob('canceled');
    const [queued] = await insertJob('queued');

    expect(canceled.status).toBe('canceled');
    expect(queued.status).toBe('queued');
    await exec(`DELETE FROM flyer_pro_jobs WHERE "documentId" = $1`, [documentId]);
  });

  it('job de encarte que não existe: o banco recusa pela FK', async () => {
    await expect(insertJob('queued', randomUUID())).rejects.toThrow(/FK_flyer_pro_jobs_document/);
  });

  it('exclusão lógica mantém o job; o expurgo físico leva os jobs, sem erro 23503', async () => {
    const doc = randomUUID();
    await insertDocumentRow(exec, clientId, doc);
    await insertJob('done', doc);
    await insertJob('canceled', doc);
    const jobsOf = async () =>
      (
        await exec(`SELECT count(*)::int AS n FROM flyer_pro_jobs WHERE "documentId" = $1`, [doc])
      )[0].n;

    await exec(`UPDATE flyer_pro_documents SET "deletedAt" = now() WHERE id = $1`, [doc]);
    expect(await jobsOf()).toBe(2);
    await exec(`DELETE FROM flyer_pro_documents WHERE id = $1`, [doc]);

    expect(await jobsOf()).toBe(0);
  });

  it('sobe de novo com um job gravado: sem erro, o job fica e os índices continuam um de cada', async () => {
    await insertJob('running');
    const jobs = () => exec(`SELECT * FROM flyer_pro_jobs`);
    const jobsBefore = await jobs();

    await m3.up(runner);

    expect(await catalog()).toEqual(firstUp);
    expect(await jobs()).toEqual(jobsBefore);
    const names = await indexesIn(exec, schema);
    for (const name of M3_INDEXES) expect(names.filter((n) => n === name)).toHaveLength(1);
  });

  it('desce: a tabela e os dois índices somem, e encarte, itens e importação ficam iguais', async () => {
    await m3.down(runner);

    expect(await tablesIn(exec, schema)).toEqual(
      ['clients', ...TABLES_OF_OTHERS, ...ALL_TABLES].sort(),
    );
    const left = await indexesIn(exec, schema);
    for (const name of M3_INDEXES) expect(left).not.toContain(name);
    expect(await catalogOf(runner, schema, ALL_TABLES)).toEqual(catalogBefore);
    expect(await documentTables()).toEqual(before);
    expect(await othersOf(exec, schema)).toEqual(othersBefore);
  });

  it('sobe de novo depois de descer: tudo igual à primeira subida', async () => {
    await m3.up(runner);

    expect(await catalog()).toEqual(firstUp);
  });
});
