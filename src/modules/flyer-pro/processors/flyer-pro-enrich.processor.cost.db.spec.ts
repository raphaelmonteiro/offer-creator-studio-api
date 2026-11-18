// A busca de fotos do provedor real puxa o importador de fotos da DotCompany → sharp, que não carrega no host.
jest.mock('sharp', () => jest.fn());

import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { openAiError } from '../../ai/utils/openai-chat.testutil';
import { jobRowOf, makeEnrichWorld, useEnrichDb, wrapPort } from './flyer-pro-enrich.testutil';
import { CALL_COST, realPort } from './flyer-pro-enrich.real.testutil';

describeIfE2eDb(
  'modelos, custo e prazo do job com o provedor real (serviços de IA simulados)',
  () => {
    const db = useEnrichDb();
    const { newDocument, start } = db;

    async function runJob(env: Record<string, string> = {}, count = 78) {
      const { documentId } = await newDocument(count);
      const real = realPort({ env });
      const world = makeEnrichWorld(db.dataSource, { port: real.port });
      const jobId = await start(world, documentId);
      await world.drain();
      return jobRowOf(db.dataSource, jobId);
    }

    describe('models', () => {
      it('sem variável de modelo: o modelo padrão do uso, em cada fase que rodou', async () => {
        const job = await runJob();
        expect(job.models).toEqual({
          categorize: 'gpt-6-luna',
          spellcheck: 'gpt-6-luna',
          image_match: 'gpt-6-luna',
        });
      });

      it('OPENAI_SPELLCHECK_MODEL=gpt-4o: models.spellcheck é gpt-4o', async () => {
        const job = await runJob({ OPENAI_SPELLCHECK_MODEL: 'gpt-4o' });
        expect(job.models).toMatchObject({ spellcheck: 'gpt-4o', categorize: 'gpt-6-luna' });
      });

      it('fase pulada não traz modelo', async () => {
        const job = await runJob({ AI_SPELLCHECK_ENABLED: 'false' });
        expect(job.models).not.toHaveProperty('spellcheck');
        expect(job.models).toMatchObject({ categorize: 'gpt-6-luna' });
      });
    });

    describe('costUsd', () => {
      it('78 itens nos modelos padrão: a soma das chamadas de categorias, ortografia e leitura do nome', async () => {
        const job = await runJob();
        // 2 lotes de categorias (1 chamada cada), 8 chamadas de ortografia (10 nomes cada) e 5 lotes de fotos
        expect(Number(job.costUsd)).toBeCloseTo(15 * CALL_COST, 6);
      });

      it('modelo sem preço (gpt-4o na ortografia): costUsd nulo, nunca zero, até o fim do job', async () => {
        const job = await runJob({ OPENAI_SPELLCHECK_MODEL: 'gpt-4o' });
        expect(job).toMatchObject({ status: 'done', costUsd: null });
      });

      it('lote que falhou depois de pagar: o custo das 3 chamadas concluídas entra com a falha gravada', async () => {
        const { documentId } = await newDocument(40);
        const real = realPort({
          spellCall: async (call) => {
            if (call !== 4) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw openAiError(401, 'chave inválida');
          },
        });
        const world = makeEnrichWorld(db.dataSource, { port: real.port });
        const jobId = await start(world, documentId, { steps: ['spellcheck'] });

        await world.drain();

        const job = await jobRowOf(db.dataSource, jobId);
        expect(job).toMatchObject({ status: 'failed', error: { phase: 'spellcheck' } });
        expect(Number(job.costUsd)).toBeCloseTo(3 * CALL_COST, 6);
      });

      it('lote descartado pela ficha (o job terminou no meio da chamada): costUsd não muda', async () => {
        const { documentId } = await newDocument(10);
        const real = realPort();
        const port = wrapPort(real.port, {
          spellcheck: async (_items, context) => {
            await db.dataSource.query(
              `UPDATE flyer_pro_jobs SET status = 'canceled', "finishedAt" = now() WHERE id = $1`,
              [context.jobId],
            );
          },
        });
        const world = makeEnrichWorld(db.dataSource, { port });
        const jobId = await start(world, documentId, { steps: ['spellcheck'] });

        await world.drain();

        expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
          status: 'canceled',
          costUsd: null,
          models: null,
        });
        expect(real.spellCreate).toHaveBeenCalled();
      });

      it('um custo desconhecido numa falha marca o job: a soma que vem depois não volta a valer', async () => {
        const { documentId } = await newDocument(40);
        const real = realPort({
          env: { OPENAI_SPELLCHECK_MODEL: 'gpt-4o' },
          spellCall: async (call) => {
            if (call !== 4) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw openAiError(503, 'indisponível');
          },
        });
        const world = makeEnrichWorld(db.dataSource, { port: real.port });
        const jobId = await start(world, documentId, { steps: ['spellcheck'] });

        await world.drain();

        expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
          status: 'done',
          costUsd: null,
        });
      });
    });

    describe('chamada abandonada pelo prazo', () => {
      it('o prazo estoura, o job registra AI_TIMEOUT e o sinal da chamada à OpenAI é abortado de fato', async () => {
        const { documentId } = await newDocument(3);
        const real = realPort();
        let signal: AbortSignal | undefined;
        real.categorizeCreate.mockImplementation(
          (_body: unknown, options: { signal: AbortSignal }) =>
            new Promise((_, reject) => {
              signal = options.signal;
              options.signal.addEventListener('abort', () =>
                reject(new Error('Request was aborted.')),
              );
            }),
        );
        const world = makeEnrichWorld(db.dataSource, {
          port: real.port,
          config: { batchDeadlineMs: 50 },
        });
        const jobId = await start(world, documentId, { steps: ['categorize'] });

        await world.deliverOne();

        expect(signal?.aborted).toBe(true);
        expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
          status: 'running',
          batchAttempts: 1,
        });
        expect(world.messages[0].options).toMatchObject({ startAfterSeconds: 15 });
      });

      it('o prazo estoura com uma chamada paga em andamento depois de 3 concluídas: costUsd nulo e o job marcado como desconhecido (D-orq-1)', async () => {
        const { documentId } = await newDocument(40);
        const real = realPort({
          spellCall: (call) => (call === 4 ? new Promise<void>(() => undefined) : undefined),
        });
        const world = makeEnrichWorld(db.dataSource, {
          port: real.port,
          config: { batchDeadlineMs: 300 },
        });
        const jobId = await start(world, documentId, { steps: ['spellcheck'] });

        await world.deliverOne();

        expect(real.spellCreate).toHaveBeenCalledTimes(4);
        expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
          status: 'running',
          batchAttempts: 1,
          costUsd: null,
          cursor: { costUnknown: true },
        });
      });
    });
  },
);
