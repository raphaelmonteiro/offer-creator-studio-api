import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { FlyerProItem } from '../entities/flyer-pro-item.entity';
import {
  CURSOR,
  documentRow,
  itemRow,
  makeService,
  snapshotOf,
  STATUS,
} from './flyer-pro-documents.service.testutil';

describe('FlyerProDocumentsService.open (N3)', () => {
  it('encarte inexistente ou excluído: 404 FLYER_PRO_NOT_FOUND, e a busca não inclui os excluídos', async () => {
    const { service, manager } = makeService();
    manager.findOne.mockResolvedValue(null);

    await expect(service.open('d1')).rejects.toMatchObject({
      status: 404,
      response: { code: 'FLYER_PRO_NOT_FOUND', message: 'Encarte não encontrado ou excluído.' },
    });

    expect(manager.findOne).toHaveBeenCalledWith(FlyerProDocument, { where: { id: 'd1' } });
    expect(manager.find).not.toHaveBeenCalled();
  });

  it('lê tudo numa transação REPEATABLE READ e passa o manager dela ao statusOf (A-12)', async () => {
    const { service, dataSource, manager, snapshots } = makeService();

    await service.open('d1');

    expect(dataSource.transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
    expect(snapshots.statusOf).toHaveBeenCalledWith(expect.anything(), manager);
  });

  it('a cópia guardada vai sem remontar ao statusOf, e o montador não é chamado', async () => {
    const { service, manager, snapshots } = makeService();
    const snapshot = snapshotOf('54x40');
    manager.findOne.mockResolvedValue(documentRow({ templateSnapshot: snapshot }));

    const view = await service.open('d1');

    expect(snapshots.statusOf.mock.calls[0][0]).toBe(snapshot);
    expect(snapshots.build).not.toHaveBeenCalled();
    expect(view.templateSnapshot).toBe(snapshot);
    expect(view.templateStatus).toBe(STATUS);
  });

  it('os itens vêm por position e, no empate, por id; o cursor é o texto que o banco devolveu', async () => {
    const { service, manager } = makeService();
    manager.find.mockResolvedValue([itemRow({ id: 'a' }), itemRow({ id: 'b', position: 1 })]);

    const view = await service.open('d1');

    expect(manager.find).toHaveBeenCalledWith(FlyerProItem, {
      where: { documentId: 'd1' },
      order: { position: 'ASC', id: 'ASC' },
    });
    expect(view.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(view.itemsCursor).toBe(CURSOR);
  });

  it('o cursor sai do banco: maior updatedAt dos itens ou createdAt do encarte, em UTC com microssegundos', async () => {
    const { service, manager } = makeService();

    await service.open('d1');

    const [sql, params] = manager.query.mock.calls[0];
    expect(params).toEqual(['d1']);
    expect(sql).toContain('max("updatedAt")');
    expect(sql).toContain('"createdAt"');
    expect(sql).toContain(`AT TIME ZONE 'UTC'`);
    expect(sql).toContain('SS.US');
  });

  it('não grava nada: nenhuma escrita no manager, no repositório nem no dataSource', async () => {
    const { service, manager, documents, dataSource } = makeService();

    await service.open('d1');

    expect(manager.insert).not.toHaveBeenCalled();
    expect(documents.update).not.toHaveBeenCalled();
    expect(dataSource.query).not.toHaveBeenCalled();
    for (const [sql] of manager.query.mock.calls) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    }
  });
});

describe('FlyerProDocumentsService.open (N3): o job do encarte', () => {
  it('enrichment é o job que o encarte mostra, lido no manager da mesma transação REPEATABLE READ', async () => {
    const { service, manager, jobs } = makeService();
    const job = { id: 'job-1', status: 'done' };
    jobs.currentView.mockResolvedValue(job);

    const view = await service.open('d1');

    expect(view.enrichment).toBe(job);
    expect(jobs.currentView).toHaveBeenCalledWith(manager, 'd1');
  });

  it('encarte que nunca teve job: enrichment nulo', async () => {
    const { service } = makeService();

    expect((await service.open('d1')).enrichment).toBeNull();
  });
});

describe('FlyerProDocumentsService.remove (N6)', () => {
  const sqlOf = (manager: { query: jest.Mock }) =>
    manager.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' '));

  it('exclui e responde { deleted: true }', async () => {
    const { service } = makeService();

    await expect(service.remove('d1')).resolves.toEqual({ deleted: true });
  });

  it('trava o encarte vivo, grava só deletedAt (as outras colunas não são tocadas) e depois pede a parada do job', async () => {
    const { service, manager } = makeService();

    await service.remove('d1');

    expect(manager.findOne).toHaveBeenCalledWith(FlyerProDocument, {
      where: { id: 'd1' },
      lock: { mode: 'pessimistic_write' },
    });
    const [entity, criteria, set] = manager.update.mock.calls[0];
    expect(entity).toBe(FlyerProDocument);
    expect(criteria).toEqual({ id: 'd1' });
    expect(Object.keys(set)).toEqual(['deletedAt']);
    expect(set.deletedAt()).toBe('now()');
    expect(manager.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      manager.update.mock.invocationCallOrder[0],
    );
    expect(manager.update.mock.invocationCallOrder[0]).toBeLessThan(
      manager.query.mock.invocationCallOrder[0],
    );
  });

  it('o pedido de parada vai só para o job ativo do encarte, com o primeiro cancelRequestedAt mantido', async () => {
    const { service, manager } = makeService();

    await service.remove('d1');

    const [sql] = sqlOf(manager);
    expect(sql).toContain('UPDATE "flyer_pro_jobs"');
    expect(sql).toContain('COALESCE("cancelRequestedAt", now())');
    expect(sql).toContain(`"documentId" = $1 AND "status" IN ('queued', 'running')`);
    expect(manager.query.mock.calls[0][1]).toEqual(['d1']);
  });

  it('encarte inexistente ou já excluído: 404 FLYER_PRO_NOT_FOUND, sem excluir nem pedir parada', async () => {
    const { service, manager } = makeService();
    manager.findOne.mockResolvedValue(null);

    await expect(service.remove('d1')).rejects.toMatchObject({
      status: 404,
      response: { code: 'FLYER_PRO_NOT_FOUND' },
    });
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('dois pedidos juntos: o primeiro exclui e o segundo, que achou o encarte já excluído depois da trava, responde 404', async () => {
    const { service, manager } = makeService();
    manager.findOne.mockResolvedValueOnce(documentRow()).mockResolvedValueOnce(null);

    const results = await Promise.allSettled([service.remove('d1'), service.remove('d1')]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(manager.update).toHaveBeenCalledTimes(1);
  });

  it('se o pedido de parada falhar, a exclusão não vale: o erro sobe e a transação aborta', async () => {
    const { service, manager } = makeService();
    manager.query.mockRejectedValue(new Error('banco caiu'));

    await expect(service.remove('d1')).rejects.toThrow('banco caiu');
  });
});
