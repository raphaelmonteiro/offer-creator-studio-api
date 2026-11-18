import { HttpException } from '@nestjs/common';
import { flyerProImportIdConflict, flyerProImportInvalid } from '../domain/flyer-pro.errors';
import { IMPORT_ID, importEntry } from './flyer-pro-imports.service.testutil';
import {
  columnsSetBy,
  makeSaveService,
  saveBody,
  storedDocument,
} from './flyer-pro-save.service.testutil';

const import_ = importEntry();

describe('FlyerProSaveService.save: o passo da importação, na ordem do salvar', () => {
  it('roda depois do Setup e antes dos itens, com o manager da transação, o encarte da rota e o usuário do token', async () => {
    const { service, setup, imports, items, manager, updates } = makeSaveService();

    await service.save(
      'ana',
      'd1',
      saveBody({ setup: { name: 'N' }, import: import_, items: { upsert: [] } }),
    );

    expect(imports.apply).toHaveBeenCalledWith(manager, 'd1', 'ana', import_);
    const order = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];
    expect(order(setup.apply)).toBeLessThan(order(imports.apply));
    expect(order(imports.apply)).toBeLessThan(order(items.apply));
    expect(order(items.apply)).toBeLessThan(
      manager.query.mock.invocationCallOrder[manager.query.mock.calls.length - 1],
    );
    expect(updates()).toHaveLength(1);
  });

  it('o Setup que recusa (FLYER_PRO_FOLD_LOCKED com replace no mesmo corpo, ou cliente inexistente) para antes da importação', async () => {
    const { service, setup, imports, updates } = makeSaveService();
    setup.apply.mockRejectedValue(new HttpException({ code: 'FLYER_PRO_FOLD_LOCKED' }, 422));

    await expect(
      service.save(
        'ana',
        'd1',
        saveBody({ setup: { sceneId: 's' }, import: importEntry({ mode: 'replace' }) }),
      ),
    ).rejects.toMatchObject({ response: { code: 'FLYER_PRO_FOLD_LOCKED' } });

    expect(imports.apply).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });

  it.each([
    ['422 das contagens', flyerProImportInvalid([{ field: 'acceptedCount', code: 'EMPTY' }])],
    ['409 do id de outro encarte', flyerProImportIdConflict(IMPORT_ID)],
  ])('o %s derruba o corpo: o ramo de itens não roda e nada é gravado', async (_, refusal) => {
    const { service, imports, items, updates } = makeSaveService();
    imports.apply.mockRejectedValue(refusal);

    await expect(
      service.save(
        'ana',
        'd1',
        saveBody({ slices: { card: {} }, import: import_, items: { upsert: [] } }),
      ),
    ).rejects.toBe(refusal);

    expect(items.apply).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });
});

describe('FlyerProSaveService.save: o corpo com import e a revisão', () => {
  it('com revisão velha é 409 REVISION_CONFLICT, e não 200 applied: false (nunca é regravação de conferência)', async () => {
    const { service, imports, updates } = makeSaveService(storedDocument({ revision: 38 }));

    await expect(
      service.save('ana', 'd1', saveBody({ expectedRevision: 37, import: import_ })),
    ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });

    expect(imports.apply).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });

  it('só os quatro obrigatórios e o import, na revisão certa: sobe a revisão e grava a mutação e o autor', async () => {
    const { service, imports, updates } = makeSaveService(storedDocument({ revision: 38 }));

    const view = await service.save(
      'bruno',
      'd1',
      saveBody({ expectedRevision: 38, import: import_ }),
    );

    expect(view).toMatchObject({ revision: 39, applied: true, replayed: false });
    expect(imports.apply).toHaveBeenCalledTimes(1);
    expect(updates()).toHaveLength(1);
    expect(columnsSetBy(updates()[0])).toMatchObject({
      revision: 39,
      lastMutationId: 'M1',
      updatedByUserId: 'bruno',
    });
  });

  it('o reenvio pelo mutationId vem antes e não toca a importação', async () => {
    const { service, imports, calls } = makeSaveService(storedDocument({ lastMutationId: 'M1' }));

    const view = await service.save('ana', 'd1', saveBody({ import: import_ }));

    expect(view).toMatchObject({ replayed: true, applied: true });
    expect(imports.apply).not.toHaveBeenCalled();
    expect(calls()).toEqual([]);
  });

  it('o corpo sem import não chama o passo', async () => {
    const { service, imports } = makeSaveService();

    await service.save('ana', 'd1', saveBody({ slices: { card: {} } }));

    expect(imports.apply).not.toHaveBeenCalled();
  });
});

describe('FlyerProSaveService.save: pagesFrozen e a importação', () => {
  it('"Substituir" novo: pagesFrozen = false vai no mesmo UPDATE da revisão, e a resposta traz false', async () => {
    const { service, imports, updates } = makeSaveService(storedDocument({ pagesFrozen: true }));
    imports.apply.mockResolvedValue({ pagesFrozen: false });

    const view = await service.save(
      'ana',
      'd1',
      saveBody({ import: importEntry({ mode: 'replace' }) }),
    );

    expect(view.pagesFrozen).toBe(false);
    expect(updates()).toHaveLength(1);
    expect(columnsSetBy(updates()[0])).toMatchObject({ pagesFrozen: false, revision: 38 });
  });

  it('"Acrescentar" ou importação reenviada: a coluna fica fora do UPDATE e pagesFrozen continua true', async () => {
    const { service, updates } = makeSaveService(storedDocument({ pagesFrozen: true }));

    const view = await service.save('ana', 'd1', saveBody({ import: import_ }));

    expect(view.pagesFrozen).toBe(true);
    expect(updates()[0].sql).not.toContain('"pagesFrozen"');
  });

  it('o servidor não apaga item nem grava fatia por causa da importação: só as colunas do PATCH', async () => {
    const { service, items, updates } = makeSaveService();

    await service.save('ana', 'd1', saveBody({ import: importEntry({ mode: 'replace' }) }));

    expect(items.apply).not.toHaveBeenCalled();
    expect(Object.keys(columnsSetBy(updates()[0])).sort()).toEqual(
      [
        'engineVersion',
        'lastMutationId',
        'revision',
        'schemaVersion',
        'updatedAt',
        'updatedByUserId',
      ].sort(),
    );
  });
});
