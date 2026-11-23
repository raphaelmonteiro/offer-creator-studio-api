import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { TransientProviderError } from '../../../shared/providers/provider-errors';
import {
  EnrichWorld,
  itemRowsOf,
  jobRowOf,
  makeEnrichWorld,
  resultOf,
  Row,
  useEnrichDb,
} from './flyer-pro-enrich.testutil';
import { applied, pending, scriptedPort } from './flyer-pro-enrich.retry.testutil';
import { insertItems } from '../testing/flyer-pro-documents.fixture';

const EAN = '7896000000019';

describeIfE2eDb('processador do job: passadas do EAN pendente (image_ean_retry)', () => {
  const db = useEnrichDb();
  const { newDocument, start } = db;

  /** Entrega o próximo lote e devolve a fase do job e a espera pedida para o lote seguinte. */
  async function step(world: EnrichWorld, jobId: string) {
    await world.deliverOne();
    const job = await jobRowOf(db.dataSource, jobId);
    return { job, phase: job.phase, wait: world.messages.at(-1)?.options.startAfterSeconds };
  }

  async function runToEnd(world: EnrichWorld, jobId: string) {
    const phases: unknown[] = [];
    const waits: Array<number | undefined> = [];
    while (world.messages.length > 0) {
      waits.push(world.messages[0].options.startAfterSeconds);
      const { phase } = await step(world, jobId);
      phases.push(phase);
    }
    return { phases, waits, job: await jobRowOf(db.dataSource, jobId) };
  }

  const photoJob = (documentId: string, world: EnrichWorld, over: object = {}) =>
    start(world, documentId, { steps: ['image_match'], ...over });

  describe('repetição do EAN pendente', () => {
    it('a foto chega antes da segunda passada: pendente na fase de fotos e na passada de 30 s, aplicada na de 60 s', async () => {
      const { documentId } = await newDocument(1, () => ({
        name: 'CERVEJA PILSEN LATA 350ML',
        ean: EAN,
      }));
      const { port, calls } = scriptedPort((item, ctx) =>
        ctx.pass >= 2 ? applied(item.id) : pending(item.id),
      );
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await photoJob(documentId, world);

      const { phases, waits, job } = await runToEnd(world, jobId);

      expect(calls.map((call) => call.pass)).toEqual([0, 1, 2]);
      expect(waits).toEqual([undefined, 30, 60]);
      expect(phases).toEqual(['image_ean_retry', 'image_ean_retry', null]);
      expect(job.status).toBe('done');
      const [item] = await itemRowsOf(db.dataSource, documentId);
      expect(item).toMatchObject({ imageStatus: 'applied', imageOrigin: 'match', imageWidth: 600 });
    });

    it('foto que não chega: as 3 passadas esperam 30, 60 e 120 s, o item segue ean_pending sem escrita nelas e o job termina done', async () => {
      const { documentId } = await newDocument(1, () => ({ name: 'CERVEJA', ean: EAN }));
      const { port, calls } = scriptedPort((item) => pending(item.id));
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await photoJob(documentId, world);
      await step(world, jobId);
      const [afterPhotos] = await itemRowsOf(db.dataSource, documentId);

      const { waits, job } = await runToEnd(world, jobId);

      expect(calls.map((call) => call.pass)).toEqual([0, 1, 2, 3]);
      expect(waits).toEqual([30, 60, 120]);
      expect(job.status).toBe('done');
      const [item] = await itemRowsOf(db.dataSource, documentId);
      expect(item).toMatchObject({ imageStatus: 'ean_pending' });
      expect(item.updatedAt).toEqual(afterPhotos.updatedAt);
      expect(item.imageReview).toEqual(afterPhotos.imageReview);
    });

    it('job novo só para os pendentes: a fase de fotos não acha item, total e processed ficam 0 e as passadas rodam', async () => {
      const { documentId } = await newDocument(1, () => ({
        name: 'CERVEJA',
        ean: EAN,
        imageStatus: 'ean_pending',
      }));
      const { port, calls } = scriptedPort((item, ctx) =>
        ctx.pass === 2 ? applied(item.id) : pending(item.id),
      );
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await photoJob(documentId, world);
      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({ total: 0, processed: 0 });

      const { job } = await runToEnd(world, jobId);

      expect(calls.map((call) => call.pass)).toEqual([1, 2]);
      expect(job).toMatchObject({ status: 'done', total: 0, processed: 0 });
    });

    it('parar durante a espera: o job fica canceled e a busca de fotos não é chamada de novo', async () => {
      const { documentId } = await newDocument(1, () => ({ name: 'CERVEJA', ean: EAN }));
      const { port, calls } = scriptedPort((item) => pending(item.id));
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await photoJob(documentId, world);
      await step(world, jobId);
      await step(world, jobId);
      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({ phase: 'image_ean_retry' });
      await db.dataSource.query(
        `UPDATE flyer_pro_jobs SET "cancelRequestedAt" = now() WHERE id = $1`,
        [jobId],
      );
      const before = calls.length;

      await world.drain();

      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
        status: 'canceled',
        phase: 'image_ean_retry',
      });
      expect(calls).toHaveLength(before);
    });

    it('conferência final com as passadas já usadas: a rodada nova deixa um item pendente e nenhuma passada nova roda', async () => {
      const { documentId } = await newDocument(1, () => ({ name: 'CERVEJA', ean: EAN }));
      let imported = false;
      const { port, calls } = scriptedPort(async (item, ctx) => {
        if (ctx.pass === 3 && !imported) {
          imported = true;
          await insertItems(db.dataSource, documentId, [
            { name: 'NOVO A', position: 5 },
            { name: 'NOVO B', position: 6 },
          ]);
        }
        return item.name === 'NOVO A' ? applied(item.id) : pending(item.id);
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await photoJob(documentId, world);

      const { job } = await runToEnd(world, jobId);

      expect(calls.map((call) => call.pass)).toEqual([0, 1, 2, 3, 0]);
      expect(job).toMatchObject({ status: 'done', total: 3 });
      const items = await itemRowsOf(db.dataSource, documentId);
      expect(items.map((item) => item.imageStatus)).toEqual([
        'ean_pending',
        'applied',
        'ean_pending',
      ]);
    });
  });

  describe('fim das passadas', () => {
    it('nenhum pendente: nenhuma passada é publicada e a fase nunca vale image_ean_retry', async () => {
      const { documentId } = await newDocument(3);
      const { port, calls } = scriptedPort((item) => applied(item.id));
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await photoJob(documentId, world);

      const { phases, job } = await runToEnd(world, jobId);

      expect(phases).not.toContain('image_ean_retry');
      expect(calls.map((call) => call.pass)).toEqual([0]);
      expect(job.status).toBe('done');
    });

    it('job sem a fase de fotos: o item ean_pending de um job anterior não dispara passada', async () => {
      const { documentId } = await newDocument(1, () => ({
        name: 'CERVEJA',
        ean: EAN,
        imageStatus: 'ean_pending',
      }));
      const { port, calls } = scriptedPort((item) => pending(item.id));
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId, { steps: ['categorize'] });

      const { job } = await runToEnd(world, jobId);

      expect(calls).toEqual([]);
      expect(job.status).toBe('done');
    });

    it('a passada lê os pendentes em lotes do tamanho da fase de fotos, sem espera entre os lotes da mesma passada', async () => {
      const { documentId } = await newDocument(5, (index) => ({
        name: `CERVEJA ${index}`,
        ean: EAN,
      }));
      const { port, calls } = scriptedPort(
        (item, ctx) => (ctx.pass === 0 ? pending(item.id) : applied(item.id)),
        {},
      );
      const world = makeEnrichWorld(db.dataSource, { port, config: { imageBatch: 2 } });
      const jobId = await photoJob(documentId, world);

      const { waits, job } = await runToEnd(world, jobId);

      expect(calls.map((call) => [call.pass, call.names.length])).toEqual([
        [0, 2],
        [0, 2],
        [0, 1],
        [1, 2],
        [1, 2],
        [1, 1],
      ]);
      // espera só antes da primeira passada (30 s); os lotes seguintes e a passada que fecha sem pendente saem na hora
      expect(waits.filter((wait) => wait !== undefined)).toEqual([30]);
      expect(job.status).toBe('done');
    });
  });

  describe('progresso durante as passadas', () => {
    it('a barra fica cheia: processed e total não mudam, o item que sai de pendente troca de contagem e o tempo vai para timing.image_ean_retry', async () => {
      const { documentId } = await newDocument(3, (index) => ({
        name: `CERVEJA ${index}`,
        ean: EAN,
      }));
      const { port } = scriptedPort(
        (item, ctx) =>
          ctx.pass === 2 && item.name === 'CERVEJA 0' ? applied(item.id) : pending(item.id),
        { delayMs: 5 },
      );
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await photoJob(documentId, world);
      const afterPhotos = (await step(world, jobId)).job;
      expect(afterPhotos).toMatchObject({ total: 3, processed: 3, phase: 'image_ean_retry' });
      expect(resultOf(afterPhotos).image_match).toMatchObject({
        visited: 3,
        eanPending: 3,
        applied: 0,
      });

      await step(world, jobId);
      const afterSecond = (await step(world, jobId)).job;

      expect(afterSecond).toMatchObject({ total: 3, processed: 3 });
      expect(resultOf(afterSecond).image_match).toMatchObject({
        visited: 3,
        applied: 1,
        eanPending: 2,
      });
      const { job } = await runToEnd(world, jobId);
      expect(job).toMatchObject({ status: 'done', total: 3, processed: 3 });
      const timing = resultOf(job).timing.image_ean_retry;
      expect(timing.batches).toBe(3);
      expect(timing.totalMs).toBeGreaterThan(0);
      expect(timing.maxMs).toBeGreaterThan(0);
    });
  });

  describe('falha numa passada do EAN', () => {
    it('três tentativas da primeira passada falham: failed com error.phase image_ean_retry e os itens seguem ean_pending', async () => {
      const { documentId } = await newDocument(1, () => ({ name: 'CERVEJA', ean: EAN }));
      const { port } = scriptedPort((item, ctx) => {
        if (ctx.pass >= 1) throw new TransientProviderError('HTTP 503');
        return pending(item.id);
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await photoJob(documentId, world);

      const { job } = await runToEnd(world, jobId);

      expect(job).toMatchObject({
        status: 'failed',
        phase: 'image_ean_retry',
        error: { code: 'AI_PROVIDER_ERROR', phase: 'image_ean_retry' },
      });
      const items: Row[] = await itemRowsOf(db.dataSource, documentId);
      expect(items[0]).toMatchObject({ imageStatus: 'ean_pending' });
    });
  });

  describe('conferência final sem a busca por nome (D-5 (a))', () => {
    it('o item sem EAN que ficou none volta como qualquer none: 3 rodadas, total cresce 1 por rodada, nenhuma chamada paga', async () => {
      const { documentId } = await newDocument(1, () => ({ name: 'SALSINHA' }));
      const { port, calls } = scriptedPort((item) => ({ itemId: item.id, action: 'unanswered' }));
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await photoJob(documentId, world);

      const totals: number[] = [];
      while (world.messages.length > 0) {
        totals.push((await step(world, jobId)).job.total as number);
      }

      const job = await jobRowOf(db.dataSource, jobId);
      expect(calls.map((call) => call.pass)).toEqual([0, 0, 0]);
      expect(totals).toEqual([2, 3, 3]);
      expect(job).toMatchObject({ status: 'done', total: 3, processed: 3 });
      const [item] = await itemRowsOf(db.dataSource, documentId);
      expect(item).toMatchObject({ imageStatus: 'none', imageReview: null });
    });
  });
});
