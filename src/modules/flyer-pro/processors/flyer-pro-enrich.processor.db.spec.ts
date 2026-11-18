import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  itemRowsOf,
  jobRowOf,
  makeEnrichWorld,
  mixedItems,
  mockPort,
  resultOf,
  Row,
  useEnrichDb,
  wrapPort,
} from './flyer-pro-enrich.testutil';
import type { EnrichStep } from '../domain/flyer-pro-job.types';

/** As colunas do item que o job nunca escreve (a lista da spec "O que o job nunca escreve"). */
const UNTOUCHED = [
  'name',
  'price',
  'unit',
  'ean',
  'position',
  'sourceName',
  'imported',
  'isAlcoholic',
  'importId',
];
const pick = (row: Row, keys: string[]) => Object.fromEntries(keys.map((key) => [key, row[key]]));

describeIfE2eDb('processador do job: o fluxo dos lotes (banco de e2e, fila registrada)', () => {
  const db = useEnrichDb();
  const { newDocument, start } = db;
  it('Job de 78 itens até o fim: 234 processados, 2, 2 e 5 lotes, modelo mock, e o encarte intocado', async () => {
    const { documentId } = await newDocument(78, mixedItems);
    const world = makeEnrichWorld(db.dataSource);
    const [before] = await db.dataSource.query(`SELECT * FROM flyer_pro_documents WHERE id = $1`, [
      documentId,
    ]);
    const jobId = await start(world, documentId);
    expect(world.messages).toHaveLength(1);

    const delivered = await world.drain();

    const job = await jobRowOf(db.dataSource, jobId);
    expect(delivered).toBe(9);
    expect(job).toMatchObject({
      status: 'done', phase: null, total: 234, processed: 234, heartbeatAt: null,
      batchAttempts: 0, error: null, costUsd: null, models: { categorize: 'mock', spellcheck: 'mock', image_match: 'mock' },
    }); // prettier-ignore
    expect(job.finishedAt).toBeInstanceOf(Date);
    const result = resultOf(job);
    expect(result.categorize).toMatchObject({
      visited: 78,
      applied: 20,
      unchanged: 58,
      suggested: 0,
      skipped: null,
    });
    expect(result.spellcheck).toMatchObject({ visited: 78, suggested: 20, clean: 58 });
    const photos = result.image_match as Record<string, number>;
    expect(photos.visited).toBe(78);
    expect(photos.applied + photos.review + photos.notFound).toBe(78);
    expect([photos.applied, photos.review, photos.notFound].every((n) => n > 0)).toBe(true);
    const { timing } = result;
    expect([
      timing.categorize.batches,
      timing.spellcheck.batches,
      timing.image_match.batches,
    ]).toEqual([2, 2, 5]);
    for (const phase of Object.values(timing)) {
      expect(phase.totalMs).toBeGreaterThan(0);
      expect(phase.maxMs).toBeGreaterThan(0);
      expect(phase.maxMs).toBeLessThanOrEqual(phase.totalMs);
    }
    const [after] = await db.dataSource.query(`SELECT * FROM flyer_pro_documents WHERE id = $1`, [
      documentId,
    ]);
    expect(after.revision).toBe(12);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.updatedByUserId).toEqual(before.updatedByUserId);
    expect(after.lastMutationId).toEqual(before.lastMutationId);
  });

  it('o job nunca escreve name, price, unit, ean, position, sourceName, imported, isAlcoholic nem importId, e nunca troca o nome pela correção', async () => {
    const { documentId } = await newDocument(20, mixedItems);
    const before = await itemRowsOf(db.dataSource, documentId);
    const world = makeEnrichWorld(db.dataSource);
    await start(world, documentId);

    await world.drain();

    const after = await itemRowsOf(db.dataSource, documentId);
    expect(after.map((row) => pick(row, UNTOUCHED))).toEqual(
      before.map((row) => pick(row, UNTOUCHED)),
    );
    const misspelled = after.find((row) => String(row.name).startsWith('FILE DE TILAPIA'));
    expect(misspelled?.spellReview).toMatchObject({
      checkedName: misspelled?.name,
      suggestion: {
        status: 'pending',
        value: expect.stringContaining('FILÉ DE TILÁPIA CONGELADO'),
      },
    });
  });

  it('aplica a categoria com autoApply: category ai, a sugestão accepted com auto true, e a foto aplicada com a medida do arquivo', async () => {
    const { documentId } = await newDocument(8, (i) => ({ name: `CERVEJA PILSEN ${i}` }));
    const world = makeEnrichWorld(db.dataSource);
    await start(world, documentId);

    await world.drain();

    const items = await itemRowsOf(db.dataSource, documentId);
    for (const item of items) {
      expect(item).toMatchObject({ category: 'Bebidas', categorySource: 'ai' });
      expect(item.categoryReview).toMatchObject({
        suggestion: { category: 'Bebidas', status: 'accepted', auto: true },
      });
    }
    const applied = items.filter((item) => item.imageStatus === 'applied');
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]).toMatchObject({ imageOrigin: 'match', imageWidth: 600, imageHeight: 1200 });
    expect(applied[0].imageReview).toMatchObject({
      applied: { reasons: [expect.stringContaining('[simulado]')] },
    });
  });

  it('só fotos: a fase é image_match e nenhum item ganha revisão de categoria ou de ortografia', async () => {
    const { documentId } = await newDocument(20, mixedItems);
    const world = makeEnrichWorld(db.dataSource);
    const jobId = await start(world, documentId, { steps: ['image_match'] });

    await world.deliverOne();

    expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
      status: 'running',
      phase: 'image_match',
    });
    await world.drain();
    for (const item of await itemRowsOf(db.dataSource, documentId)) {
      expect(item.categoryReview).toBeNull();
      expect(item.spellReview).toBeNull();
    }
  });

  it('com FLYER_PRO_ENRICH_IMAGE_BATCH=8, os 78 itens pedem 10 lotes de fotos, e o timing diz 10', async () => {
    const { documentId } = await newDocument(78);
    const world = makeEnrichWorld(db.dataSource, { config: { imageBatch: 8 } });
    const jobId = await start(world, documentId, { steps: ['image_match'] });

    const delivered = await world.drain();

    expect(delivered).toBe(10);
    expect(resultOf(await jobRowOf(db.dataSource, jobId)).timing.image_match.batches).toBe(10);
  });

  it('número exato de itens: o terceiro lote de categorias não acha item, fecha a fase e não conta no timing', async () => {
    const { documentId } = await newDocument(80);
    const world = makeEnrichWorld(db.dataSource);
    const jobId = await start(world, documentId, { steps: ['categorize'] });

    const delivered = await world.drain();

    const job = await jobRowOf(db.dataSource, jobId);
    expect(delivered).toBe(3);
    expect(job.status).toBe('done');
    expect(resultOf(job).timing.categorize.batches).toBe(2);
    expect(resultOf(job).categorize.visited).toBe(80);
  });

  it('job com total 0 (nada a fazer): nasce queued e o worker o fecha done sem chamar o provedor', async () => {
    const { documentId } = await newDocument(3, () => ({
      imageStatus: 'applied',
      imageOrigin: 'picker',
    }));
    const calls: string[] = [];
    const port = wrapPort(mockPort(), { matchImages: () => void calls.push('fotos') });
    const world = makeEnrichWorld(db.dataSource, { port });
    const jobId = await start(world, documentId, { steps: ['image_match'] });
    expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({ status: 'queued', total: 0 });

    await world.drain();

    expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
      status: 'done',
      total: 0,
      processed: 0,
    });
    expect(calls).toEqual([]);
  });

  describe('fase indisponível é pulada', () => {
    it('categorias desligadas: skipped AI_DISABLED, nenhum item ganha categoryReview, ortografia e fotos rodam, e processed chega a total', async () => {
      const { documentId } = await newDocument(10, mixedItems);
      const port = wrapPort(mockPort(), {
        available: (phase: EnrichStep) => phase !== 'categorize',
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId);

      await world.drain();

      const job = await jobRowOf(db.dataSource, jobId);
      const result = resultOf(job);
      expect(job).toMatchObject({ status: 'done', processed: 30, total: 30 });
      expect(result.categorize.skipped).toBe('AI_DISABLED');
      expect(result.spellcheck.visited).toBe(10);
      expect(result.image_match.visited).toBe(10);
      expect((job.models as Row).categorize).toBeUndefined();
      for (const item of await itemRowsOf(db.dataSource, documentId))
        expect(item.categoryReview).toBeNull();
    });

    it('a fase pulada não volta na conferência final: o job termina done sem outra rodada por causa das categorias', async () => {
      const { documentId } = await newDocument(5, mixedItems);
      const port = wrapPort(mockPort(), {
        available: (phase: EnrichStep) => phase !== 'categorize',
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId);

      const delivered = await world.drain();

      expect((await jobRowOf(db.dataSource, jobId)).cursor).toMatchObject({ round: 1 });
      expect(delivered).toBe(3);
    });
  });
});
