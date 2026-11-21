import { randomUUID } from 'crypto';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import {
  DocumentBody,
  envelope,
  importedItemsPayload,
  rowOf,
  savePayload,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import { enrichmentE2e } from '../testing/flyer-pro-enrichment.e2e.testutil';
import { importEntry } from '../testing/flyer-pro-imports.fixture';
import { insertJob } from '../testing/flyer-pro-jobs.fixture';
import type { FlyerProJobView } from '../views/flyer-pro-job.view';
import type { FlyerProSaveView } from '../views/flyer-pro-save.view';

type Job = FlyerProJobView;
const SLOW = 90_000;

/**
 * e2e do job de enriquecimento (change 28), com a fila real (pg-boss) no `chroma_x_e2e` e o consumidor no próprio
 * processo, sobre a semente da 05 e o provedor simulado. Só o fluxo base e o que depende do app montado (guard, pipe
 * global, SQL real, fila real, índice único); o resto está nos unitários e nos specs de banco do processador (L-19).
 */
describeIfE2eDb('job de enriquecimento: N14, N15, N16 e o processamento (e2e, fila real)', () => {
  const { h, url, create, open, patch, noToken } = useDocumentsE2e({
    scenes: false,
    jobQueue: true,
  });
  jest.setTimeout(SLOW); // os jobs levam de segundos a minutos (a fila busca a cada 2 s)
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  const { enrichment, jobOf, startJob, documentWith, until, queued } = enrichmentE2e({
    h,
    url,
    create,
  });
  const ALL = ['categorize', 'spellcheck', 'image_match'];

  afterAll(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  describe('rotas', () => {
    it('Buscar fotos de 78 itens: 202 com o job queued, o lote na fila do banco de e2e, e o job termina done', async () => {
      const id = await documentWith(78);

      const response = await startJob(id, {
        steps: ['image_match'],
        itemIds: null,
        onlyMissing: true,
        autoApply: true,
      });

      expect(response.status).toBe(202);
      const job = envelope<Job>(response).data;
      expect(job).toMatchObject({
        status: 'queued',
        steps: ['image_match'],
        total: 78,
        processed: 0,
        phase: null,
        result: {},
        error: null,
        models: null,
        costUsd: null,
        startedAt: null,
        heartbeatAt: null,
        finishedAt: null,
        cancelRequested: false,
        createdByUserId: h.seed.user.id,
        itemIds: null,
      });
      expect((await queued(job.id))[0].n).toBe(1);
      expect((await until(id, ['done'])).processed).toBe(78);
    });

    it('sem token 401, encarte excluído 404, e a forma inválida em encarte excluído é 400 antes do 404', async () => {
      const id = await documentWith(2);
      expect((await noToken(`${enrichment(id)}`)).status).toBe(401);
      const anonymous = h.http().post(`/v1${enrichment(id)}`);
      expect((await anonymous.send({ steps: ['image_match'] })).status).toBe(401);
      await h.delete(`${url}/${id}`);

      expect((await startJob(id, { steps: ['image_match'] })).status).toBe(404);
      expect((await startJob(id, { steps: [] })).status).toBe(400);
      expect((await h.get(enrichment('abc'))).status).toBe(404);
    });

    it('Dois pedidos ao mesmo tempo: um 202 e um 409 com o mesmo jobId (índice único real), e um job ativo só', async () => {
      const id = await documentWith(78);

      const responses = await Promise.all([
        startJob(id, { steps: ['image_match'] }),
        startJob(id, { steps: ['image_match'] }),
      ]);

      const [ok, conflict] = responses.sort((a, b) => a.status - b.status);
      expect([ok.status, conflict.status]).toEqual([202, 409]);
      expect(envelope<unknown>(conflict).error).toMatchObject({
        code: 'FLYER_PRO_ENRICHMENT_RUNNING',
        details: { jobId: envelope<Job>(ok).data.id },
      });
      const [{ n }] = await h.dataSource.query(
        `SELECT count(*)::int AS n FROM flyer_pro_jobs WHERE "documentId" = $1 AND status IN ('queued','running')`,
        [id],
      );
      expect(n).toBe(1);
      await h.post(`${enrichment(id)}/cancel`);
      await until(id, ['canceled', 'done']);
    });

    it('N15: sem job é { job: null }; depois de done traz o job concluído com o timing 2, 2 e 5 lotes', async () => {
      const id = await documentWith(78);
      expect(await jobOf(id)).toBeNull();

      await startJob(id, { steps: ALL });
      const job = await until(id, ['done']);

      expect(job).toMatchObject({
        status: 'done',
        phase: null,
        total: 234,
        processed: 234,
        stalled: false,
      });
      expect(job.models).toEqual({ categorize: 'mock', spellcheck: 'mock', image_match: 'mock' });
      const timing = (
        job.result as {
          timing: Record<string, { batches: number; totalMs: number; maxMs: number }>;
        }
      ).timing;
      expect([
        timing.categorize.batches,
        timing.spellcheck.batches,
        timing.image_match.batches,
      ]).toEqual([2, 2, 5]);
      expect(timing.image_match.totalMs).toBeGreaterThan(0);
    });

    it('N16 com o job na fila: canceled na hora; sem job ativo, canceled false com o mais recente', async () => {
      const id = await documentWith(3);
      const jobId = await insertJob(h.dataSource, id, { status: 'queued', steps: ['image_match'] });

      const stopped = envelope<{ canceled: boolean; job: Job }>(
        await h.post(`${enrichment(id)}/cancel`),
      ).data;
      const again = envelope<{ canceled: boolean; job: Job }>(
        await h.post(`${enrichment(id)}/cancel`),
      ).data;

      expect(stopped).toMatchObject({ canceled: true, job: { id: jobId, status: 'canceled' } });
      expect(stopped.job.finishedAt).not.toBeNull();
      expect(again).toMatchObject({ canceled: false, job: { id: jobId, status: 'canceled' } });
      const nothing = await documentWith(1);
      expect(envelope<unknown>(await h.post(`${enrichment(nothing)}/cancel`)).data).toEqual({
        canceled: false,
        job: null,
      });
    });

    it('N16 com um lote rodando (#ia-lenta): cancelRequested true, o lote termina, grava e o job fica canceled', async () => {
      const id = await documentWith(40, 'Teste #ia-lenta');
      await startJob(id, { steps: ['image_match'] });
      await until(id, ['running']);

      const stopped = envelope<{ canceled: boolean; job: Job }>(
        await h.post(`${enrichment(id)}/cancel`),
      ).data;

      expect(stopped).toMatchObject({
        canceled: true,
        job: { status: 'running', cancelRequested: true },
      });
      const job = await until(id, ['canceled'], 60_000);
      expect(job.processed).toBe(16);
      const [{ n }] = await h.dataSource.query(
        `SELECT count(*)::int AS n FROM flyer_pro_items WHERE "documentId" = $1 AND "imageStatus" <> 'none'`,
        [id],
      );
      expect(n).toBe(16);
    });
  });

  describe('salvar (N4) com enrich', () => {
    it('Importação que já pede o job, a corrida com o pedido manual e o reenvio do corpo que criou o job', async () => {
      const response = await create(h.seed.scenes.frontBack.id);
      const { id } = envelope<DocumentBody>(response).data;
      const entry = importEntry({ id: randomUUID() });
      const body = savePayload(0, {
        import: entry,
        items: { upsert: importedItemsPayload(entry.id, 78) },
        enrich: { steps: ALL },
      });

      const saved = envelope<FlyerProSaveView>(await patch(id, body)).data;

      expect(saved).toMatchObject({ revision: 1, applied: true, replayed: false });
      expect(saved.enrichment).toMatchObject({
        started: true,
        job: { status: 'queued', total: 234 },
      });
      const jobId = (saved.enrichment as { job: Job }).job.id;
      const replay = envelope<FlyerProSaveView>(await patch(id, body)).data;
      expect(replay).toMatchObject({
        replayed: true,
        enrichment: { started: false, job: { id: jobId } },
      });
      const manual = await startJob(id, { steps: ['image_match'] });
      expect(manual.status).toBe(409);
      const again = envelope<FlyerProSaveView>(
        await patch(
          id,
          savePayload(1, {
            enrich: { steps: ALL },
            items: { upsert: importedItemsPayload(entry.id, 1, 200) },
          }),
        ),
      ).data;
      expect(again.enrichment).toMatchObject({ started: false, job: { id: jobId } });
      const [{ n }] = await h.dataSource.query(
        `SELECT count(*)::int AS n FROM flyer_pro_jobs WHERE "documentId" = $1`,
        [id],
      );
      expect(n).toBe(1);
      await h.post(`${enrichment(id)}/cancel`);
      await until(id, ['canceled', 'done']);
    });
  });

  describe('o job termina sem a tela', () => {
    it('fechar e reabrir: o job termina done sem ninguém consultar, e a abertura traz o job e os itens com o resultado', async () => {
      const id = await documentWith(20);
      await startJob(id, { steps: ALL });

      for (;;) {
        const [row] = await h.dataSource.query(
          `SELECT status FROM flyer_pro_jobs WHERE "documentId" = $1`,
          [id],
        );
        if (row.status === 'done') break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const opened = await open(id);

      expect(opened.enrichment).toMatchObject({ status: 'done', processed: 60, total: 60 });
      expect(opened.items.every((item) => item.imageStatus !== 'none')).toBe(true);
      expect(
        opened.items.every((item) => item.spellReview !== null && item.categoryReview !== null),
      ).toBe(true);
      expect(opened.itemsCursor).toBe((opened.enrichment as Job).itemsUpdatedAt);
      expect((await rowOf(h.dataSource, id)).revision).toBe(0);
    });

    it('falha terminal (#ia-falha-terminal): failed na primeira falha, e a abertura mostra o job que falhou', async () => {
      const id = await documentWith(20, 'Teste #ia-falha-terminal');
      await startJob(id, { steps: ['image_match'] });

      const job = await until(id, ['failed']);

      expect(job.error).toMatchObject({ code: 'AI_PROVIDER_ERROR', phase: 'image_match' });
      expect((await open(id)).enrichment).toMatchObject({
        status: 'failed',
        error: { code: 'AI_PROVIDER_ERROR' },
      });
    });

    it('entrega dupla: a mesma mensagem publicada de novo não assume a ficha e o job não muda', async () => {
      const id = await documentWith(5);
      await startJob(id, { steps: ['categorize'] });
      const done = await until(id, ['done']);
      const [before] = await h.dataSource.query(
        `SELECT "updatedAt", "batchSeq" FROM flyer_pro_jobs WHERE id = $1`,
        [done.id],
      );

      await h.app.app
        .get(AnimationQueueService)
        .publish(QUEUES.FLYER_PRO_ENRICH, { jobId: done.id, seq: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const [after] = await h.dataSource.query(
        `SELECT "updatedAt", "batchSeq" FROM flyer_pro_jobs WHERE id = $1`,
        [done.id],
      );
      expect(after).toEqual(before);
      expect((await jobOf(id))?.status).toBe('done');
    });
  });

  describe('exclusão do encarte (N6) com o job ativo', () => {
    it('Excluir com um lote rodando (#ia-lenta): grava o pedido na mesma transação, o lote termina e o job fica canceled', async () => {
      const id = await documentWith(40, 'Teste #ia-lenta');
      const { data: job } = envelope<Job>(await startJob(id, { steps: ['image_match'] }));
      await until(id, ['running']);

      const deleted = await h.delete(`${url}/${id}`);

      expect(deleted.status).toBe(200);
      const [row] = await h.dataSource.query(
        `SELECT status, "cancelRequestedAt" FROM flyer_pro_jobs WHERE id = $1`,
        [job.id],
      );
      expect(row.cancelRequestedAt).not.toBeNull();
      for (;;) {
        const [current] = await h.dataSource.query(
          `SELECT status, processed FROM flyer_pro_jobs WHERE id = $1`,
          [job.id],
        );
        if (current.status !== 'running') {
          expect(current).toMatchObject({ status: 'canceled', processed: 16 });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect((await h.get(enrichment(id))).status).toBe(404);
    });
  });
});
