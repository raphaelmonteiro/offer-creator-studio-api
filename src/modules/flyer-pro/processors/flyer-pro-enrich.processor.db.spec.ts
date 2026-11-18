import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { RealFlyerProEnrich } from '../providers/flyer-pro-enrich.real';
import { insertItems, ItemSeed } from '../testing/flyer-pro-documents.fixture';
import {
  itemRowsOf,
  jobRowOf,
  makeEnrichWorld,
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
  /** Itens com palavra da tabela de categorias, grafia errada e nome sem nada, em partes iguais. */
  const mixed = (index: number): ItemSeed => ({
    name: [
      `CERVEJA PILSEN ${index}`,
      `FILE DE TILAPIA CONJELADO ${index}`,
      `PRODUTO ${index}`,
      `PRODUTO ${index}`,
    ][index % 4],
  });

  it('Job de 78 itens até o fim: 234 processados, 2, 2 e 5 lotes, modelo mock, e o encarte intocado', async () => {
    const { documentId } = await newDocument(78, mixed);
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
    const { documentId } = await newDocument(20, mixed);
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
    const { documentId } = await newDocument(20, mixed);
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
      const { documentId } = await newDocument(10, mixed);
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
      const { documentId } = await newDocument(5, mixed);
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

  describe('provedor real antes da change 29 (A-27)', () => {
    it('as três fases são puladas: done com skipped AI_DISABLED, nenhum item muda, models sem mock e nenhuma chamada externa', async () => {
      const { documentId } = await newDocument(78, mixed, 'Teste #ia-falha');
      const before = await itemRowsOf(db.dataSource, documentId);
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      const world = makeEnrichWorld(db.dataSource, { port: new RealFlyerProEnrich() });
      const jobId = await start(world, documentId);

      await world.drain();

      const job = await jobRowOf(db.dataSource, jobId);
      const result = resultOf(job);
      expect(job).toMatchObject({ status: 'done', total: 234, processed: 234, costUsd: null });
      expect([
        result.categorize.skipped,
        result.spellcheck.skipped,
        result.image_match.skipped,
      ]).toEqual(['AI_DISABLED', 'AI_DISABLED', 'AI_DISABLED']);
      expect(JSON.stringify(job.models ?? {})).not.toContain('mock');
      const after = await itemRowsOf(db.dataSource, documentId);
      expect(after).toEqual(before);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe('autoApply desligado: tudo vira sugestão', () => {
    it('a categoria fica pendente e a foto vira review com a foto como candidata, sem aplicar nada', async () => {
      const { documentId } = await newDocument(12, (i) => ({ name: `CERVEJA PILSEN ${i}` }));
      const world = makeEnrichWorld(db.dataSource);
      await start(world, documentId, { autoApply: false });

      await world.drain();

      for (const item of await itemRowsOf(db.dataSource, documentId)) {
        expect(item).toMatchObject({ category: null, categorySource: null });
        expect(item.categoryReview).toMatchObject({
          suggestion: { category: 'Bebidas', status: 'pending' },
        });
        expect(item.imageStatus).not.toBe('applied');
        expect(item.imageUrl).toBeNull();
      }
      const reviews = (await itemRowsOf(db.dataSource, documentId)).filter(
        (item) => item.imageStatus === 'review',
      );
      expect(reviews.length).toBeGreaterThan(0);
    });
  });

  it('categoria da planilha preservada: category e categorySource ficam, e a sugestão da tabela vai pendente', async () => {
    const { documentId } = await newDocument(1, () => ({
      name: 'SABÃO EM PÓ 1KG',
      category: 'Mercearia',
      categorySource: 'import',
    }));
    const world = makeEnrichWorld(db.dataSource);
    await start(world, documentId, { steps: ['categorize'] });

    await world.drain();

    const [item] = await itemRowsOf(db.dataSource, documentId);
    expect(item).toMatchObject({ category: 'Mercearia', categorySource: 'import' });
    expect(item.categoryReview).toMatchObject({
      suggestion: { category: 'Limpeza', status: 'pending' },
    });
  });

  describe('conferência final', () => {
    it('importação durante o job: antes de terminar faz outra rodada e total cresce em 6 (3 fases x 2 itens)', async () => {
      const { documentId } = await newDocument(4);
      let inserted = false;
      const port = wrapPort(mockPort(), {
        matchImages: async () => {
          if (inserted) return;
          inserted = true;
          await insertItems(db.dataSource, documentId, [
            { name: 'NOVO 1', position: 100 },
            { name: 'NOVO 2', position: 101 },
          ]);
        },
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId);

      await world.drain();

      const job = await jobRowOf(db.dataSource, jobId);
      expect(job).toMatchObject({ status: 'done', total: 12 + 6, processed: 18 });
      expect(job.cursor).toMatchObject({ round: 2 });
      const novos = (await itemRowsOf(db.dataSource, documentId)).filter((item) =>
        String(item.name).startsWith('NOVO'),
      );
      for (const item of novos) {
        expect(item.categoryReview).not.toBeNull();
        expect(item.spellReview).not.toBeNull();
        expect(item.imageStatus).not.toBe('none');
      }
    });

    it('teto de rodadas: um item sem resposta em toda rodada faz 3 rodadas e o job termina done com o item ainda por fazer', async () => {
      const { documentId } = await newDocument(2);
      const silent = mockPort();
      const port = {
        ...wrapPort(silent, {}),
        matchImages: async (
          items: Parameters<typeof silent.matchImages>[0],
          context: Parameters<typeof silent.matchImages>[1],
        ) =>
          (await silent.matchImages(items, context)).filter(
            (verdict) => verdict.itemId !== items[0].id,
          ),
      };
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId, { steps: ['image_match'] });

      await world.drain();

      const job = await jobRowOf(db.dataSource, jobId);
      expect(job.status).toBe('done');
      expect(job.cursor).toMatchObject({ round: 3 });
      const left = (await itemRowsOf(db.dataSource, documentId)).filter(
        (item) => item.imageStatus === 'none',
      );
      expect(left).toHaveLength(1);
    });

    it('item deixado como estava pelo provedor não é relido na mesma fase: o segundo lote começa depois do último do primeiro', async () => {
      const { documentId } = await newDocument(6);
      const seen: string[][] = [];
      const base = mockPort();
      const port = {
        ...wrapPort(base, {}),
        categorize: async (
          items: Parameters<typeof base.categorize>[0],
          context: Parameters<typeof base.categorize>[1],
        ) => {
          seen.push(items.map((item) => item.name));
          return (await base.categorize(items, context)).filter(
            (verdict) => verdict.itemId !== items[0].id,
          );
        },
      };
      const world = makeEnrichWorld(db.dataSource, { port, config: { categoryBatch: 3 } });
      await start(world, documentId, { steps: ['categorize'] });

      await world.drain();

      expect(seen[0]).toEqual(['PRODUTO 0', 'PRODUTO 1', 'PRODUTO 2']);
      expect(seen[1]).toEqual(['PRODUTO 3', 'PRODUTO 4', 'PRODUTO 5']);
    });
  });
});
