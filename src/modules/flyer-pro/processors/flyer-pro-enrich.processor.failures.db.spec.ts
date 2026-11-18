import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import type { FlyerProEnrichPort } from '../providers/flyer-pro-enrich.port';
import {
  itemRowsOf,
  jobRowOf,
  makeEnrichWorld,
  mockPort,
  resultOf,
  useEnrichDb,
  wrapPort,
} from './flyer-pro-enrich.testutil';

/** Falha do provedor, prazo, fila indisponível e erro inesperado, provados contra o Postgres do banco de e2e. */
describeIfE2eDb('processador do job: falhas (banco de e2e)', () => {
  const db = useEnrichDb();
  const { newDocument, start } = db;

  /** A porta simulada cuja fase de fotos falha nas `times` primeiras chamadas e depois responde. */
  function failingPhotos(times: number, failure: () => Error): FlyerProEnrichPort {
    let calls = 0;
    return wrapPort(mockPort(), {
      matchImages: () => {
        calls += 1;
        if (calls <= times) throw failure();
      },
    });
  }

  describe('falha transitória', () => {
    it('três falhas seguidas: categorias e ortografia ficam gravadas, as fotos repetem com 15 s e 60 s e o job termina failed', async () => {
      const { documentId } = await newDocument(
        20,
        (i) => ({ name: `CERVEJA PILSEN ${i}` }),
        'Teste #ia-falha',
      );
      const world = makeEnrichWorld(db.dataSource);
      const jobId = await start(world, documentId);

      const delays: number[] = [];
      while (world.messages.length > 0) {
        const { options } = world.messages[0];
        if (options.startAfterSeconds) delays.push(options.startAfterSeconds);
        await world.deliverOne();
      }

      const job = await jobRowOf(db.dataSource, jobId);
      expect(delays).toEqual([15, 60]);
      expect(job).toMatchObject({
        status: 'failed',
        phase: 'image_match',
        batchAttempts: 3,
        heartbeatAt: null,
        error: {
          code: 'AI_PROVIDER_ERROR',
          phase: 'image_match',
          message: 'O serviço de IA não respondeu. Os itens que faltam continuam para conferir.',
        },
      });
      expect(job.finishedAt).toBeInstanceOf(Date);
      const items = await itemRowsOf(db.dataSource, documentId);
      for (const item of items) {
        expect(item).toMatchObject({ imageStatus: 'none', category: 'Bebidas' });
        expect(item.spellReview).not.toBeNull();
      }
    });

    it('a mesma fase é repetida com a mesma ficha, sem gravar nada nos itens do lote', async () => {
      const { documentId } = await newDocument(5);
      const world = makeEnrichWorld(db.dataSource, {
        port: failingPhotos(1, () => new TransientProviderError('HTTP 503')),
      });
      const jobId = await start(world, documentId, { steps: ['image_match'] });

      await world.deliverOne();

      const job = await jobRowOf(db.dataSource, jobId);
      expect(job).toMatchObject({
        status: 'running',
        batchAttempts: 1,
        heartbeatAt: null,
        processed: 0,
      });
      expect(world.messages).toHaveLength(1);
      expect(world.messages[0]).toMatchObject({
        data: { jobId, seq: job.batchSeq },
        options: { startAfterSeconds: 15 },
      });
      for (const item of await itemRowsOf(db.dataSource, documentId)) {
        expect(item.imageStatus).toBe('none');
      }
    });

    it('o lote que falhou não entra no timing: só os 3 lotes gravados contam', async () => {
      const { documentId } = await newDocument(40);
      const world = makeEnrichWorld(db.dataSource, {
        port: failingPhotos(1, () => new TransientProviderError('HTTP 503')),
      });
      const jobId = await start(world, documentId, { steps: ['image_match'] });

      await world.drain();

      const job = await jobRowOf(db.dataSource, jobId);
      expect(job.status).toBe('done');
      expect(resultOf(job).timing.image_match.batches).toBe(3);
    });

    it('falha seguida de sucesso: o lote grava, batchAttempts volta a 0 e o job segue até o fim', async () => {
      const { documentId } = await newDocument(5);
      const world = makeEnrichWorld(db.dataSource, {
        port: failingPhotos(1, () => new TransientProviderError('HTTP 503')),
      });
      const jobId = await start(world, documentId, { steps: ['image_match'] });

      await world.deliverOne();
      await world.deliverOne();

      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
        status: 'done',
        batchAttempts: 0,
        processed: 5,
      });
    });
  });

  describe('falha terminal', () => {
    it('termina failed na primeira falha, sem republicar o lote e sem gravar nos itens', async () => {
      const { documentId } = await newDocument(20, undefined, 'Teste #ia-falha-terminal');
      const world = makeEnrichWorld(db.dataSource);
      const jobId = await start(world, documentId, { steps: ['image_match'] });

      await world.deliverOne();

      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
        status: 'failed',
        batchAttempts: 1,
        error: { code: 'AI_PROVIDER_ERROR', phase: 'image_match' },
      });
      expect(world.messages).toEqual([]);
      for (const item of await itemRowsOf(db.dataSource, documentId)) {
        expect(item.imageStatus).toBe('none');
      }
    });

    it('continuar depois da falha terminal: um job novo, num encarte sem o marcador, pega os mesmos itens', async () => {
      const { documentId } = await newDocument(4, undefined, 'Teste #ia-falha-terminal');
      const failing = makeEnrichWorld(db.dataSource);
      await start(failing, documentId, { steps: ['image_match'] });
      await failing.drain();
      await db.dataSource.query(
        `UPDATE flyer_pro_documents SET name = 'Sem marcador' WHERE id = $1`,
        [documentId],
      );
      const retry = makeEnrichWorld(db.dataSource);

      const jobId = await start(retry, documentId, { steps: ['image_match'] });
      await retry.drain();

      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({ status: 'done', total: 4 });
    });
  });

  describe('prazo da chamada', () => {
    it('provedor lento: três tentativas estouram o prazo, o job termina failed com AI_TIMEOUT e nenhum item recebe o que chegou depois', async () => {
      const { documentId } = await newDocument(5);
      const slow = wrapPort(mockPort(), {
        matchImages: () => new Promise<void>((resolve) => setTimeout(resolve, 150)),
      });
      const world = makeEnrichWorld(db.dataSource, { port: slow, config: { batchDeadlineMs: 20 } });
      const jobId = await start(world, documentId, { steps: ['image_match'] });

      await world.drain();
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
        status: 'failed',
        error: { code: 'AI_TIMEOUT', phase: 'image_match' },
      });
      for (const item of await itemRowsOf(db.dataSource, documentId)) {
        expect(item.imageStatus).toBe('none');
      }
    });
  });

  describe('fila indisponível e erro inesperado', () => {
    it('a publicação do próximo lote falha: os itens do lote ficam gravados e o job termina failed com QUEUE_UNAVAILABLE', async () => {
      const { documentId } = await newDocument(50);
      const world = makeEnrichWorld(db.dataSource);
      const jobId = await start(world, documentId, { steps: ['categorize'] });
      world.queue.publish.mockRejectedValue(new Error('fila fora do ar'));

      await world.deliverOne();

      const job = await jobRowOf(db.dataSource, jobId);
      expect(job).toMatchObject({
        status: 'failed',
        processed: 40,
        error: {
          code: 'QUEUE_UNAVAILABLE',
          message: 'Não foi possível continuar o processamento.',
        },
      });
      const reviewed = (await itemRowsOf(db.dataSource, documentId)).filter(
        (item) => item.categoryReview !== null,
      );
      expect(reviewed).toHaveLength(40);
    });

    it('erro que não é do provedor: o job termina failed com INTERNAL e o handler termina sem erro, sem nova entrega', async () => {
      const { documentId } = await newDocument(5);
      const port = wrapPort(mockPort(), {
        matchImages: () => {
          throw new Error('bug no provedor');
        },
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId, { steps: ['image_match'] });

      await expect(world.deliverOne()).resolves.toBe(true);

      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
        status: 'failed',
        error: {
          code: 'INTERNAL',
          phase: 'image_match',
          message: 'Erro inesperado no processamento.',
        },
      });
      expect(world.messages).toEqual([]);
    });

    it('falha terminal de chave inválida lançada pelo provedor real também não repete', async () => {
      const { documentId } = await newDocument(3);
      const world = makeEnrichWorld(db.dataSource, {
        port: failingPhotos(99, () => new TerminalProviderError('chave inválida', 'provider_auth')),
      });
      const jobId = await start(world, documentId, { steps: ['image_match'] });

      await world.drain();

      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
        status: 'failed',
        batchAttempts: 1,
      });
    });
  });
});
