import { itemRow } from './flyer-pro-documents.service.testutil';
import {
  columnsSetBy,
  makeSaveService,
  saveBody,
  STAMP,
  storedDocument,
} from './flyer-pro-save.service.testutil';

const ABACATE = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c11';
const items = { upsert: [{ id: ABACATE, name: 'ABACATE' }], delete: ['i9'] };

describe('FlyerProSaveService.save: o ramo items', () => {
  it('chama o ramo com o manager da transação, o encarte, o carimbo e o usuário, depois do Setup e antes da gravação', async () => {
    const { service, setup, items: branch, manager, updates } = makeSaveService();

    await service.save('ana', 'd1', saveBody({ setup: { name: 'N' }, items }));

    expect(branch.apply).toHaveBeenCalledWith(manager, 'd1', items, {
      stamp: STAMP,
      userId: 'ana',
    });
    expect(setup.apply.mock.invocationCallOrder[0]).toBeLessThan(
      branch.apply.mock.invocationCallOrder[0],
    );
    expect(branch.apply.mock.invocationCallOrder[0]).toBeLessThan(
      manager.query.mock.invocationCallOrder[manager.query.mock.calls.length - 1],
    );
    expect(updates()).toHaveLength(1);
  });

  it('o carimbo é lido depois da trava e antes do ramo', async () => {
    const { service, items: branch, manager } = makeSaveService();

    await service.save('ana', 'd1', saveBody({ items }));

    const clock = manager.query.mock.calls.findIndex(([sql]) => sql.includes('clock_timestamp'));
    expect(manager.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      manager.query.mock.invocationCallOrder[clock],
    );
    expect(manager.query.mock.invocationCallOrder[clock]).toBeLessThan(
      branch.apply.mock.invocationCallOrder[0],
    );
  });

  it('a resposta traz os itens tocados e os ids apagados que o ramo devolveu, pela view do item', async () => {
    const { service, items: branch } = makeSaveService();
    branch.apply.mockResolvedValue({
      items: [itemRow({ id: ABACATE, ean: '7891000100103' })],
      deletedItemIds: ['i9'],
    });

    const view = await service.save('ana', 'd1', saveBody({ items }));

    expect(view.items).toEqual([expect.objectContaining({ id: ABACATE, eanValid: true })]);
    expect(view.items[0]).not.toHaveProperty('documentId');
    expect(view.deletedItemIds).toEqual(['i9']);
    expect(view.linkWarnings).toEqual([]);
  });

  it('uma recusa do ramo derruba o corpo inteiro: a fatia e a revisão não são gravadas', async () => {
    const { service, items: branch, updates } = makeSaveService();
    branch.apply.mockRejectedValue(new Error('Há itens com dados inválidos.'));

    await expect(
      service.save('ana', 'd1', saveBody({ slices: { card: {} }, items })),
    ).rejects.toThrow('Há itens');
    expect(updates()).toEqual([]);
  });

  it('o corpo sem items não chama o ramo', async () => {
    const { service, items: branch } = makeSaveService();

    await service.save('ana', 'd1', saveBody({ slices: { card: {} } }));

    expect(branch.apply).not.toHaveBeenCalled();
  });

  it('items: {} sobe a revisão (chave presente) e chama o ramo sem itens', async () => {
    const { service, items: branch } = makeSaveService();

    const view = await service.save('ana', 'd1', saveBody({ items: {} }));

    expect(view.revision).toBe(38);
    expect(branch.apply).toHaveBeenCalledTimes(1);
  });

  it('a revisão velha é 409 antes do ramo: item inválido no mesmo corpo não é conferido', async () => {
    const { service, items: branch } = makeSaveService(storedDocument({ revision: 38 }));

    await expect(service.save('ana', 'd1', saveBody({ items }))).rejects.toMatchObject({
      response: { code: 'REVISION_CONFLICT' },
    });
    expect(branch.apply).not.toHaveBeenCalled();
  });

  it('o reenvio devolve o estado atual dos itens citados, sem chamar o ramo nem gravar', async () => {
    const {
      service,
      items: branch,
      calls,
    } = makeSaveService(storedDocument({ lastMutationId: 'M1' }));
    branch.currentOf.mockResolvedValue([itemRow({ id: ABACATE, name: 'ABACATE' })]);

    const view = await service.save('ana', 'd1', saveBody({ items }));

    expect(branch.currentOf).toHaveBeenCalledWith(expect.anything(), 'd1', items.upsert);
    expect(view).toMatchObject({ replayed: true, deletedItemIds: [] });
    expect(view.items.map((item) => item.id)).toEqual([ABACATE]);
    expect(branch.apply).not.toHaveBeenCalled();
    expect(calls()).toEqual([]);
  });

  it('o carimbo do encarte também é o da gravação dos itens (a mesma hora em tudo)', async () => {
    const { service, updates } = makeSaveService();

    await service.save('ana', 'd1', saveBody({ items }));

    expect(columnsSetBy(updates()[0]).updatedAt).toBe(STAMP);
  });
});
