import { HttpException } from '@nestjs/common';
import { documentRow } from './flyer-pro-documents.service.testutil';
import {
  columnsSetBy,
  makeSaveService,
  SAVED_AT,
  saveBody,
  STAMP,
  storedDocument,
} from './flyer-pro-save.service.testutil';

/** O que a recusa devolve: status, `code` e `details`. */
async function refusalOf(promise: Promise<unknown>) {
  const error = (await promise.then(
    () => null,
    (caught: unknown) => caught,
  )) as HttpException | null;
  expect(error).toBeInstanceOf(HttpException);
  const body = error.getResponse() as { code: string; details?: unknown };
  return { status: error.getStatus(), code: body.code, details: body.details };
}

describe('FlyerProSaveService.save: gravação normal', () => {
  it('tema novo na fatia card: sobe a revisão, grava só essa fatia, a mutação, o autor e o carimbo', async () => {
    const { service, updates } = makeSaveService();
    const card = { theme: { accent: '#d00' } };

    const view = await service.save('ana', 'd1', saveBody({ slices: { card } }));

    expect(view).toMatchObject({ id: 'd1', revision: 38, replayed: false, applied: true });
    expect(updates()).toHaveLength(1);
    expect(columnsSetBy(updates()[0])).toEqual({
      card: JSON.stringify(card),
      schemaVersion: 1,
      engineVersion: 1,
      revision: 38,
      lastMutationId: 'M1',
      updatedByUserId: 'ana',
      updatedAt: STAMP,
    });
    expect(updates()[0].sql).toContain('"updatedAt" = $');
    expect(updates()[0].sql).toContain('::timestamptz');
  });

  it('a resposta traz o updatedAt gravado e o pagesFrozen da coluna', async () => {
    const { service } = makeSaveService(storedDocument({ pagesFrozen: true }));

    const view = await service.save('ana', 'd1', saveBody({ slices: { card: {} } }));

    expect(view.updatedAt).toBe(SAVED_AT.toISOString());
    expect(view.pagesFrozen).toBe(true);
  });

  it('outro usuário salva: updatedByUserId passa a ser o dele', async () => {
    const { service, updates } = makeSaveService(storedDocument({ revision: 4 }));

    const view = await service.save(
      'bruno',
      'd1',
      saveBody({ expectedRevision: 4, slices: { card: {} } }),
    );

    expect(view.revision).toBe(5);
    expect(columnsSetBy(updates()[0])).toMatchObject({ updatedByUserId: 'bruno', revision: 5 });
  });

  it('slices: {} sobe a revisão sem tocar nenhuma fatia', async () => {
    const { service, updates } = makeSaveService();

    const view = await service.save('ana', 'd1', saveBody({ slices: {} }));

    expect(view).toMatchObject({ revision: 38, applied: true });
    expect(Object.keys(columnsSetBy(updates()[0]))).toEqual([
      'schemaVersion',
      'engineVersion',
      'revision',
      'lastMutationId',
      'updatedByUserId',
      'updatedAt',
    ]);
  });

  it('cada fatia enviada vai inteira, como veio, e as não enviadas ficam fora do UPDATE', async () => {
    const { service, updates } = makeSaveService();
    const structure = { sections: [{ id: 'cat:Carnes', itemIds: ['i1'] }] };
    const assembly = { share: 0.585, other: 0.6050000000000001, 'e41a0b52-3c6d': { x: 1 } };

    await service.save('ana', 'd1', saveBody({ slices: { structure, assembly } }));

    const set = columnsSetBy(updates()[0]);
    expect(set.structure).toBe(JSON.stringify(structure));
    expect(set.assembly).toBe(JSON.stringify(assembly));
    expect(set).not.toHaveProperty('frame');
    expect(set).not.toHaveProperty('card');
    expect(set).not.toHaveProperty('exportPrefs');
  });

  it('o conteúdo da fatia não é lido: cita item que não existe e é gravada igual', async () => {
    const { service, updates } = makeSaveService();
    const structure = { sections: [{ id: 's', itemIds: ['nao-existe'] }] };

    await expect(
      service.save('ana', 'd1', saveBody({ slices: { structure } })),
    ).resolves.toMatchObject({
      applied: true,
    });
    expect(columnsSetBy(updates()[0]).structure).toBe(JSON.stringify(structure));
  });

  it('grava as versões, os digests e o layoutSnapshot que vieram; versão maior vale como veio', async () => {
    const { service, updates } = makeSaveService(storedDocument({ engineVersion: 1 }));
    const layoutSnapshot = { engineVersion: 2, level: 2 };

    await service.save(
      'ana',
      'd1',
      saveBody({
        engineVersion: 2,
        schemaVersion: 3,
        slices: { card: {} },
        layoutDigest: 'a41b',
        renderDigest: '0c9d',
        layoutSnapshot,
      }),
    );

    expect(columnsSetBy(updates()[0])).toMatchObject({
      engineVersion: 2,
      schemaVersion: 3,
      layoutDigest: 'a41b',
      renderDigest: '0c9d',
      layoutSnapshot: JSON.stringify(layoutSnapshot),
    });
  });

  it('layoutSnapshot nulo limpa a coluna (PV-10); ausente não a toca', async () => {
    const { service, updates } = makeSaveService();

    await service.save('ana', 'd1', saveBody({ slices: { card: {} }, layoutSnapshot: null }));

    expect(columnsSetBy(updates()[0])).toHaveProperty('layoutSnapshot', null);
  });

  it('sem digests nem retrato no corpo, essas colunas não entram no UPDATE', async () => {
    const { service, updates } = makeSaveService();

    await service.save('ana', 'd1', saveBody({ slices: { card: {} } }));

    const set = columnsSetBy(updates()[0]);
    expect(set).not.toHaveProperty('layoutDigest');
    expect(set).not.toHaveProperty('renderDigest');
    expect(set).not.toHaveProperty('layoutSnapshot');
  });

  it('sem os campos do template a resposta não traz format, pageCount, templateSnapshot nem templateStatus', async () => {
    const { service } = makeSaveService(storedDocument({ pagesFrozen: true }));

    const view = await service.save('ana', 'd1', saveBody({ slices: { card: {} } }));

    expect(view).toMatchObject({
      pagesFrozen: true,
      items: [],
      deletedItemIds: [],
      linkWarnings: [],
    });
    for (const field of ['format', 'pageCount', 'templateSnapshot', 'templateStatus']) {
      expect(view).not.toHaveProperty(field);
    }
  });
});

describe('FlyerProSaveService.save: trava, carimbo e recusas', () => {
  it('trava a linha viva do encarte antes de qualquer outra coisa e lê o relógio depois da trava', async () => {
    const { service, manager } = makeSaveService();

    await service.save('ana', 'd1', saveBody({ slices: { card: {} } }));

    expect(manager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'd1' },
      lock: { mode: 'pessimistic_write' },
    });
    const clock = manager.query.mock.calls.findIndex(([sql]) => sql.includes('clock_timestamp'));
    expect(manager.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      manager.query.mock.invocationCallOrder[clock],
    );
  });

  it('encarte inexistente ou excluído: 404 FLYER_PRO_NOT_FOUND, sem gravar nada', async () => {
    const { service, manager, updates } = makeSaveService();
    manager.findOne.mockResolvedValue(null);

    await expect(refusalOf(service.save('ana', 'd1', saveBody()))).resolves.toMatchObject({
      status: 404,
      code: 'FLYER_PRO_NOT_FOUND',
    });
    expect(updates()).toEqual([]);
  });

  it('corpo {} é 400 e nenhuma chamada chega ao banco, nem a transação', async () => {
    const { service, dataSource, manager } = makeSaveService();

    await expect(
      refusalOf(service.save('ana', 'd1', {} as ReturnType<typeof saveBody>)),
    ).resolves.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(manager.findOne).not.toHaveBeenCalled();
  });

  it('fatia de 300 KB é 422 FLYER_PRO_SLICE_TOO_LARGE antes do banco, mesmo para encarte que não existe', async () => {
    const { service, dataSource } = makeSaveService();
    const assembly = { a: 'x'.repeat(300 * 1024) };

    await expect(
      refusalOf(service.save('ana', 'd1', saveBody({ slices: { assembly } }))),
    ).resolves.toMatchObject({
      status: 422,
      code: 'FLYER_PRO_SLICE_TOO_LARGE',
      details: { slice: 'assembly', max: 262_144 },
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('fatia de exatamente 262 144 bytes é aceita e gravada', async () => {
    const { service, updates } = makeSaveService();
    const structure = { a: 'x'.repeat(262_144 - '{"a":""}'.length) };

    await service.save('ana', 'd1', saveBody({ slices: { structure } }));

    expect(columnsSetBy(updates()[0]).structure).toBe(JSON.stringify(structure));
  });

  it('o tamanho do corpo pesa antes de existir o encarte', async () => {
    const { service, manager } = makeSaveService();
    manager.findOne.mockResolvedValue(null);
    const layoutSnapshot = { a: 'x'.repeat(130 * 1024) };

    await expect(
      refusalOf(service.save('ana', 'd1', saveBody({ layoutSnapshot }))),
    ).resolves.toMatchObject({
      status: 422,
      details: { slice: 'layoutSnapshot', max: 131_072 },
    });
  });
});

describe('FlyerProSaveService.save: revisão, versões e reenvio', () => {
  it('revisão diferente com fatias: 409 REVISION_CONFLICT com a revisão, a hora e o autor atuais', async () => {
    const { service, updates } = makeSaveService(
      storedDocument({
        revision: 38,
        updatedByUserId: 'ana',
        updatedAt: new Date('2026-11-14T14:33:10.000Z'),
      }),
    );

    await expect(
      refusalOf(service.save('bruno', 'd1', saveBody({ slices: { card: {} } }))),
    ).resolves.toEqual({
      status: 409,
      code: 'REVISION_CONFLICT',
      details: { revision: 38, updatedAt: '2026-11-14T14:33:10.000Z', updatedByUserId: 'ana' },
    });
    expect(updates()).toEqual([]);
  });

  it('versão menor que a gravada: 409 FLYER_PRO_APP_OUTDATED com as versões gravadas', async () => {
    const { service, updates } = makeSaveService(
      storedDocument({ schemaVersion: 1, engineVersion: 2 }),
    );

    await expect(
      refusalOf(service.save('ana', 'd1', saveBody({ engineVersion: 1 }))),
    ).resolves.toEqual({
      status: 409,
      code: 'FLYER_PRO_APP_OUTDATED',
      details: { schemaVersion: 1, engineVersion: 2 },
    });
    expect(updates()).toEqual([]);
  });

  it('forma das fatias mais antiga (schemaVersion menor) também é APP_OUTDATED', async () => {
    const { service } = makeSaveService(storedDocument({ schemaVersion: 2 }));

    await expect(
      refusalOf(service.save('ana', 'd1', saveBody({ schemaVersion: 1 }))),
    ).resolves.toMatchObject({ status: 409, code: 'FLYER_PRO_APP_OUTDATED' });
  });

  it('versão velha e revisão velha juntas: vale APP_OUTDATED, a versão vem antes da revisão', async () => {
    const { service } = makeSaveService(storedDocument({ revision: 38, engineVersion: 2 }));

    await expect(
      refusalOf(service.save('ana', 'd1', saveBody({ engineVersion: 1, expectedRevision: 37 }))),
    ).resolves.toMatchObject({ code: 'FLYER_PRO_APP_OUTDATED' });
  });

  it('reenvio: mesmo mutationId responde 200 replayed e applied, a revisão atual, sem gravar', async () => {
    const { service, calls } = makeSaveService(
      storedDocument({ revision: 38, lastMutationId: 'M1' }),
    );

    const view = await service.save('ana', 'd1', saveBody({ slices: { card: {} } }));

    expect(view).toMatchObject({
      replayed: true,
      applied: true,
      revision: 38,
      items: [],
      deletedItemIds: [],
      linkWarnings: [],
    });
    expect(calls()).toEqual([]);
  });

  it('o reenvio vem antes das versões e da revisão: nunca vira 409', async () => {
    const { service } = makeSaveService(
      storedDocument({ revision: 38, lastMutationId: 'M1', engineVersion: 2 }),
    );

    await expect(
      service.save('ana', 'd1', saveBody({ engineVersion: 1, expectedRevision: 37 })),
    ).resolves.toMatchObject({ replayed: true, revision: 38 });
  });

  it('corpo antigo depois de outra gravação (lastMutationId é outro): 409 REVISION_CONFLICT', async () => {
    const { service } = makeSaveService(storedDocument({ revision: 39, lastMutationId: 'N' }));

    await expect(
      refusalOf(
        service.save('ana', 'd1', saveBody({ expectedRevision: 38, slices: { card: {} } })),
      ),
    ).resolves.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
  });

  it('o encarte recém-criado (lastMutationId nulo) aceita o primeiro PATCH na revisão 0', async () => {
    const { service } = makeSaveService(documentRow({ revision: 0, lastMutationId: null }));

    await expect(
      service.save('ana', 'd1', saveBody({ expectedRevision: 0, slices: { frame: {} } })),
    ).resolves.toMatchObject({ revision: 1, replayed: false });
  });
});
