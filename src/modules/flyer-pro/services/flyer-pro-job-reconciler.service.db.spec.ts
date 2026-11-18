import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { claimBatch } from '../processors/flyer-pro-enrich.statements';
import {
  EnrichWorld,
  itemRowsOf,
  jobRowOf,
  makeEnrichWorld,
  resultOf,
  useEnrichDb,
} from '../processors/flyer-pro-enrich.testutil';
import { insertJob, JobSeed } from '../testing/flyer-pro-jobs.fixture';
import { FlyerProJobReconcilerService } from './flyer-pro-job-reconciler.service';

/** A varredura do reconciliador contra o Postgres do banco de e2e: o relógio é o `now` que o teste passa a `reconcile`. */
describeIfE2eDb('reconciliador do job (banco de e2e)', () => {
  const db = useEnrichDb();
  const { newDocument } = db;
  const NOW = new Date();
  const secondsAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

  /** O banco é compartilhado: a varredura age em todo job ativo, então cada caso olha só as mensagens do próprio job. */
  const messagesOf = (world: EnrichWorld, jobId: string) =>
    world.messages.filter((message) => message.data.jobId === jobId);

  const reconcilerOf = (world: EnrichWorld) =>
    new FlyerProJobReconcilerService(db.dataSource, world.queue as never, world.config);

  /** Um job ativo gravado direto, com os carimbos que o caso pede. */
  async function activeJob(over: JobSeed = {}) {
    const { documentId } = await newDocument(3);
    const id = await insertJob(db.dataSource, documentId, {
      status: 'running',
      steps: ['image_match'],
      batchSeq: 7,
      updatedAt: secondsAgo(5),
      ...over,
    });
    return { documentId, id };
  }

  it('lote em dia (batimento há 10 s): o job não muda e nada é republicado', async () => {
    const { id } = await activeJob({ heartbeatAt: secondsAgo(10) });
    const world = makeEnrichWorld(db.dataSource);
    const before = await jobRowOf(db.dataSource, id);

    await reconcilerOf(world).reconcile(NOW);

    expect(await jobRowOf(db.dataSource, id)).toEqual(before);
    expect(messagesOf(world, id)).toEqual([]);
  });

  it('lote sem batimento há 61 s: sobe batchAttempts, zera o batimento e republica a mesma ficha', async () => {
    const { id } = await activeJob({ heartbeatAt: secondsAgo(61), batchAttempts: 0 });
    const world = makeEnrichWorld(db.dataSource);

    await reconcilerOf(world).reconcile(NOW);

    expect(await jobRowOf(db.dataSource, id)).toMatchObject({
      status: 'running',
      batchAttempts: 1,
      heartbeatAt: null,
    });
    expect(messagesOf(world, id)).toHaveLength(1);
    expect(messagesOf(world, id)[0]).toMatchObject({
      data: { jobId: id, seq: 7 },
      options: { retryLimit: 0, expireInSeconds: 300 },
    });
  });

  it('três lotes mortos seguidos: o job termina failed com JOB_STALLED e nada é republicado', async () => {
    const { id } = await activeJob({
      heartbeatAt: secondsAgo(61),
      batchAttempts: 2,
      phase: 'image_match',
    });
    const world = makeEnrichWorld(db.dataSource);

    await reconcilerOf(world).reconcile(NOW);

    const job = await jobRowOf(db.dataSource, id);
    expect(job).toMatchObject({
      status: 'failed',
      phase: 'image_match',
      heartbeatAt: null,
      error: {
        code: 'JOB_STALLED',
        phase: 'image_match',
        message: 'O processamento parou três vezes seguidas.',
      },
    });
    expect(job.finishedAt).toBeInstanceOf(Date);
    expect(messagesOf(world, id)).toEqual([]);
  });

  it('lote publicado e não assumido há 301 s: republica, atualiza updatedAt e não conta tentativa', async () => {
    const stale = secondsAgo(301);
    const { id } = await activeJob({ heartbeatAt: null, updatedAt: stale, batchAttempts: 1 });
    const world = makeEnrichWorld(db.dataSource);

    await reconcilerOf(world).reconcile(NOW);

    const job = await jobRowOf(db.dataSource, id);
    expect(job).toMatchObject({ batchAttempts: 1, status: 'running' });
    expect((job.updatedAt as Date).getTime()).toBeGreaterThan(stale.getTime());
    expect(messagesOf(world, id)).toEqual([
      expect.objectContaining({ data: { jobId: id, seq: 7 } }),
    ]);
  });

  it('job na fila há 301 s (mensagem perdida): também é republicado', async () => {
    const { id } = await activeJob({
      status: 'queued',
      batchSeq: 0,
      heartbeatAt: null,
      updatedAt: secondsAgo(301),
    });
    const world = makeEnrichWorld(db.dataSource);

    await reconcilerOf(world).reconcile(NOW);

    expect(messagesOf(world, id)).toEqual([
      expect.objectContaining({ data: { jobId: id, seq: 0 } }),
    ]);
  });

  describe('parada e encarte excluído', () => {
    it('parada pedida sem lote em execução: o job fica canceled', async () => {
      const { id } = await activeJob({ heartbeatAt: null, cancelRequestedAt: secondsAgo(20) });
      const world = makeEnrichWorld(db.dataSource);

      await reconcilerOf(world).reconcile(NOW);

      const job = await jobRowOf(db.dataSource, id);
      expect(job.status).toBe('canceled');
      expect(job.finishedAt).toBeInstanceOf(Date);
      expect(messagesOf(world, id)).toEqual([]);
    });

    it('parada pedida com o lote vivo: o lote fecha o job, a varredura não mexe', async () => {
      const { id } = await activeJob({
        heartbeatAt: secondsAgo(5),
        cancelRequestedAt: secondsAgo(2),
      });
      const world = makeEnrichWorld(db.dataSource);

      await reconcilerOf(world).reconcile(NOW);

      expect(await jobRowOf(db.dataSource, id)).toMatchObject({ status: 'running' });
    });

    it('encarte excluído logicamente: o job queued fica canceled, sem chamar o provedor', async () => {
      const { id, documentId } = await activeJob({
        status: 'queued',
        batchSeq: 0,
        heartbeatAt: null,
      });
      await db.dataSource.query(
        `UPDATE flyer_pro_documents SET "deletedAt" = now() WHERE id = $1`,
        [documentId],
      );
      const world = makeEnrichWorld(db.dataSource);

      await reconcilerOf(world).reconcile(NOW);

      expect(await jobRowOf(db.dataSource, id)).toMatchObject({ status: 'canceled' });
      expect(messagesOf(world, id)).toEqual([]);
    });

    it('lote imediato do N16 não publicado: na varredura seguinte o job fica canceled', async () => {
      const { id } = await activeJob({
        heartbeatAt: null,
        cancelRequestedAt: secondsAgo(1),
        updatedAt: secondsAgo(1),
      });
      const world = makeEnrichWorld(db.dataSource, { publishFails: true });

      await reconcilerOf(world).reconcile(NOW);

      expect(await jobRowOf(db.dataSource, id)).toMatchObject({ status: 'canceled' });
    });
  });

  it('job terminado não entra na varredura', async () => {
    const { id } = await activeJob({ status: 'done', heartbeatAt: secondsAgo(500) });
    const world = makeEnrichWorld(db.dataSource);
    const before = await jobRowOf(db.dataSource, id);

    expect(await reconcilerOf(world).reconcile(NOW)).toBe(0);

    expect(await jobRowOf(db.dataSource, id)).toEqual(before);
  });

  it('a fila falha ao republicar: nada muda (savepoint) e a varredura seguinte tenta de novo', async () => {
    const { id } = await activeJob({ heartbeatAt: secondsAgo(61), batchAttempts: 0 });
    const down = makeEnrichWorld(db.dataSource, { publishFails: true });
    const before = await jobRowOf(db.dataSource, id);

    await reconcilerOf(down).reconcile(NOW);
    expect(await jobRowOf(db.dataSource, id)).toEqual(before);

    const up = makeEnrichWorld(db.dataSource);
    await reconcilerOf(up).reconcile(NOW);
    expect(messagesOf(up, id)).toHaveLength(1);
    expect(await jobRowOf(db.dataSource, id)).toMatchObject({ batchAttempts: 1 });
  });

  describe('retomada depois de reinício do worker', () => {
    it('worker morto no meio de um lote: a varredura do boot republica, o job segue do ponto em que parou e termina done sem item em dobro', async () => {
      const { documentId } = await newDocument(40);
      const world = makeEnrichWorld(db.dataSource);
      const job = await db.dataSource.transaction((manager) =>
        world.jobs.createJob(manager, {
          documentId,
          userId: '00000000-0000-4000-8000-000000000001',
          steps: ['image_match'],
          itemIds: null,
          onlyMissing: true,
          autoApply: true,
        }),
      );
      await world.deliverOne(); // lote 1 gravado
      world.messages.length = 0; // a mensagem do lote 2 morre com o worker
      await claimBatch(db.dataSource, job.id, 1); // o lote 2 assumiu a ficha e o processo morreu
      await db.dataSource.query(
        `UPDATE flyer_pro_jobs SET "heartbeatAt" = now() - interval '5 minutes', "updatedAt" = now() - interval '5 minutes' WHERE id = $1`,
        [job.id],
      );

      await reconcilerOf(world).reconcile(new Date());
      world.messages.splice(0, world.messages.length, ...messagesOf(world, job.id)); // só as do próprio job
      expect(world.messages).toEqual([
        expect.objectContaining({ data: { jobId: job.id, seq: 2 } }),
      ]);
      await world.drain();

      const done = await jobRowOf(db.dataSource, job.id);
      expect(done).toMatchObject({ status: 'done', processed: 40, batchAttempts: 0 });
      expect(resultOf(done).timing.image_match.batches).toBe(3);
      const reviewed = (await itemRowsOf(db.dataSource, documentId)).map(
        (item) => (item.imageReview as { jobId: string }).jobId,
      );
      expect(reviewed).toEqual(Array(40).fill(job.id));
    });
  });
});
