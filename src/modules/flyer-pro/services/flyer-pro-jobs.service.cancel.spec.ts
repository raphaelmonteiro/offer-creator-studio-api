import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { DOC, jobRow, makeJobsService } from './flyer-pro-jobs.service.testutil';

const sqlOf = (manager: { query: jest.Mock }): string[] =>
  manager.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' '));

describe('FlyerProJobsService.cancel (N16)', () => {
  it('job na fila: vira canceled na hora, com finishedAt, e nenhum lote é publicado', async () => {
    const queued = jobRow({ status: 'queued' });
    const canceled = jobRow({
      status: 'canceled',
      finishedAt: new Date(),
      cancelRequestedAt: new Date(),
    });
    const { service, manager, queue } = makeJobsService({ active: queued, reloaded: canceled });

    const result = await service.cancel(DOC);

    expect(result.canceled).toBe(true);
    expect(result.job).toMatchObject({ status: 'canceled', cancelRequested: true });
    expect(result.job?.finishedAt).not.toBeNull();
    expect(sqlOf(manager).some((sql) => sql.includes(`"status" = 'canceled'`) && sql.includes('"finishedAt" = now()'))).toBe(true); // prettier-ignore
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('com um lote rodando: grava o pedido, o job segue running, e nenhum lote imediato sai', async () => {
    const running = jobRow({ status: 'running', heartbeatAt: new Date(), batchSeq: 3 });
    const { service, queue } = makeJobsService({
      active: running,
      reloaded: { ...running, cancelRequestedAt: new Date() },
    });

    const result = await service.cancel(DOC);

    expect(result).toMatchObject({
      canceled: true,
      job: { status: 'running', cancelRequested: true, finishedAt: null },
    });
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('o primeiro cancelRequestedAt vale: o UPDATE usa COALESCE e o pedido repetido responde canceled true', async () => {
    const first = new Date('2026-11-14T13:05:10.000Z');
    const running = jobRow({
      status: 'running',
      heartbeatAt: new Date(),
      cancelRequestedAt: first,
    });
    const { service, manager } = makeJobsService({ active: running, reloaded: running });

    const result = await service.cancel(DOC);

    expect(result.canceled).toBe(true);
    expect(sqlOf(manager).some((sql) => sql.includes('COALESCE("cancelRequestedAt", now())'))).toBe(
      true,
    );
  });

  it('sem lote em execução (esperando a repetição): publica um lote imediato com a ficha atual', async () => {
    const waiting = jobRow({ status: 'running', heartbeatAt: null, batchSeq: 7 });
    const { service, queue, manager } = makeJobsService({ active: waiting, reloaded: waiting });

    const result = await service.cancel(DOC);

    expect(result.canceled).toBe(true);
    expect(queue.publish).toHaveBeenCalledWith(
      QUEUES.FLYER_PRO_ENRICH,
      { jobId: 'job-1', seq: 7 },
      { manager, retryLimit: 0, expireInSeconds: 300 },
    );
  });

  it('a falha ao publicar o lote imediato não muda a resposta, e só o savepoint é desfeito', async () => {
    const waiting = jobRow({ status: 'running', heartbeatAt: null, batchSeq: 7 });
    const { service, queue, manager } = makeJobsService({ active: waiting, reloaded: waiting });
    queue.publish.mockRejectedValue(new Error('fila fora do ar'));

    const result = await service.cancel(DOC);

    expect(result).toMatchObject({
      canceled: true,
      job: { status: 'running', cancelRequested: false },
    });
    const sql = sqlOf(manager);
    expect(sql).toContain('SAVEPOINT flyer_pro_cancel_batch');
    expect(sql).toContain('ROLLBACK TO SAVEPOINT flyer_pro_cancel_batch');
    expect(sql).not.toContain('RELEASE SAVEPOINT flyer_pro_cancel_batch');
  });

  it('sem job ativo: canceled false com o job mais recente, e nada muda', async () => {
    const done = jobRow({ status: 'done' });
    const { service, manager, queue } = makeJobsService({ active: null, latest: done });

    const result = await service.cancel(DOC);

    expect(result).toMatchObject({ canceled: false, job: { id: 'job-1', status: 'done' } });
    expect(sqlOf(manager).some((sql) => sql.startsWith('UPDATE'))).toBe(false);
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('encarte sem job: canceled false e job null', async () => {
    const { service } = makeJobsService();

    expect(await service.cancel(DOC)).toEqual({ canceled: false, job: null });
  });

  it('com a flag do job desligada, parar continua funcionando', async () => {
    const queued = jobRow({ status: 'queued' });
    const { service } = makeJobsService(
      { active: queued, reloaded: jobRow({ status: 'canceled', finishedAt: new Date() }) },
      { enabled: false },
    );

    expect(await service.cancel(DOC)).toMatchObject({
      canceled: true,
      job: { status: 'canceled' },
    });
  });

  it('encarte excluído ou inexistente: 404, sem tocar no job', async () => {
    const { service, manager } = makeJobsService({ documentLive: false });

    await expect(service.cancel(DOC)).rejects.toMatchObject({ status: 404 });
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('trava só a linha do job: o encarte é lido sem trava e o job com FOR UPDATE (A-23)', async () => {
    const { service, manager } = makeJobsService({
      active: jobRow({ status: 'queued' }),
      reloaded: jobRow({ status: 'canceled' }),
    });

    await service.cancel(DOC);

    const documentRead = manager.findOne.mock.calls.find(([entity]) => entity === FlyerProDocument);
    expect(documentRead?.[1]).not.toHaveProperty('lock');
    const jobRead = manager.findOne.mock.calls.find(([entity]) => entity !== FlyerProDocument);
    expect(jobRead?.[1]).toMatchObject({ lock: { mode: 'pessimistic_write' } });
  });
});
