import { IsNull } from 'typeorm';
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

describe('FlyerProDocumentsService.remove (N6)', () => {
  it('exclui e responde { deleted: true }', async () => {
    const { service, documents } = makeService();
    documents.update.mockResolvedValue({ affected: 1 });

    await expect(service.remove('d1')).resolves.toEqual({ deleted: true });
  });

  it('só grava deletedAt, e só onde ele ainda é nulo (as outras colunas não são tocadas)', async () => {
    const { service, documents } = makeService();
    documents.update.mockResolvedValue({ affected: 1 });

    await service.remove('d1');

    const [criteria, set] = documents.update.mock.calls[0];
    expect(criteria).toEqual({ id: 'd1', deletedAt: IsNull() });
    expect(Object.keys(set)).toEqual(['deletedAt']);
    expect(set.deletedAt()).toBe('now()');
  });

  it.each([{ affected: 0 }, { affected: undefined }])(
    'sem linha mudada (%j): 404 FLYER_PRO_NOT_FOUND',
    async (result) => {
      const { service, documents } = makeService();
      documents.update.mockResolvedValue(result);

      await expect(service.remove('d1')).rejects.toMatchObject({
        status: 404,
        response: { code: 'FLYER_PRO_NOT_FOUND' },
      });
    },
  );

  it('dois pedidos juntos: o que muda a linha responde 200 e o outro 404', async () => {
    const { service, documents } = makeService();
    documents.update.mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 });

    const results = await Promise.allSettled([service.remove('d1'), service.remove('d1')]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  });
});
