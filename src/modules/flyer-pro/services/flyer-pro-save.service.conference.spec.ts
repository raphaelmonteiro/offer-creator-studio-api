import { HttpException } from '@nestjs/common';
import {
  columnsSetBy,
  makeSaveService,
  saveBody,
  storedDocument,
} from './flyer-pro-save.service.testutil';

const RESULT = {
  engineVersion: 2,
  layoutDigest: '7e02b9c4a1d35f66',
  renderDigest: 'c41f0a97d2be8813',
  layoutSnapshot: { engineVersion: 2, level: 2, placed: { 'e41a0b52-3c6d': [1, 1, 0, 1, 1, 1] } },
};

/** O encarte do cenário: revisão 38, motor 1, gravado pela Ana. */
const stored = (over = {}) => storedDocument({ revision: 38, engineVersion: 1, ...over });

/** A regravação de conferência: só os obrigatórios e o resultado calculado. */
const conference = (over: Record<string, unknown> = {}) =>
  saveBody({ expectedRevision: 38, ...RESULT, ...over });

describe('FlyerProSaveService.save: regravação de conferência aplicada', () => {
  it('grava só engineVersion, digests e layoutSnapshot, sem revisão, updatedAt, autor, mutação nem schemaVersion', async () => {
    const { service, updates } = makeSaveService(stored());

    const view = await service.save('bruno', 'd1', conference());

    expect(view).toMatchObject({ applied: true, replayed: false, revision: 38 });
    expect(updates()).toHaveLength(1);
    expect(columnsSetBy(updates()[0])).toEqual({
      layoutDigest: '7e02b9c4a1d35f66',
      renderDigest: 'c41f0a97d2be8813',
      layoutSnapshot: JSON.stringify(RESULT.layoutSnapshot),
      engineVersion: 2,
    });
    for (const column of [
      'revision',
      'updatedAt',
      'updatedByUserId',
      'lastMutationId',
      'schemaVersion',
    ]) {
      expect(updates()[0].sql).not.toContain(`"${column}" =`);
    }
  });

  it('a resposta traz a revisão e o updatedAt de antes, que a gravação não mudou', async () => {
    const { service } = makeSaveService(stored());

    const view = await service.save('bruno', 'd1', conference());

    expect(view.revision).toBe(38);
    expect(view.updatedAt).toBe('2026-11-14T13:05:40.000Z');
  });

  it('só o que veio é gravado: um dos três resultados basta', async () => {
    const { service, updates } = makeSaveService(stored());

    await service.save('bruno', 'd1', saveBody({ expectedRevision: 38, layoutDigest: 'abc' }));

    expect(columnsSetBy(updates()[0])).toEqual({ layoutDigest: 'abc', engineVersion: 1 });
  });

  it('só com os obrigatórios não há o que gravar: 200 applied e nenhum comando', async () => {
    const { service, updates } = makeSaveService(stored());

    const view = await service.save('bruno', 'd1', saveBody({ expectedRevision: 38 }));

    expect(view).toMatchObject({ applied: true, revision: 38 });
    expect(updates()).toEqual([]);
  });

  it('repetida com o mesmo mutationId é aplicada de novo e responde igual', async () => {
    const { service, updates } = makeSaveService(stored());

    const first = await service.save('bruno', 'd1', conference({ mutationId: 'F1' }));
    const second = await service.save('bruno', 'd1', conference({ mutationId: 'F1' }));

    expect(second).toEqual(first);
    expect(updates()).toHaveLength(2);
    expect(columnsSetBy(updates()[1])).toEqual(columnsSetBy(updates()[0]));
  });

  it('não grava lastMutationId: um reenvio do PATCH anterior continua reconhecido', async () => {
    const { service, updates } = makeSaveService(stored({ lastMutationId: 'M' }));

    await service.save('bruno', 'd1', conference());
    const replay = await service.save(
      'ana',
      'd1',
      saveBody({ mutationId: 'M', slices: { card: {} } }),
    );

    expect(replay).toMatchObject({ replayed: true, applied: true });
    expect(updates()).toHaveLength(1);
  });

  it('o motor mais antigo que o gravado é 409 FLYER_PRO_APP_OUTDATED, como em qualquer PATCH', async () => {
    const { service, updates } = makeSaveService(stored({ engineVersion: 2 }));

    const error = await service
      .save('bruno', 'd1', conference({ engineVersion: 1 }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(409);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'FLYER_PRO_APP_OUTDATED',
    });
    expect(updates()).toEqual([]);
  });
});

describe('FlyerProSaveService.save: regravação de conferência descartada', () => {
  it('com a revisão diferente responde 200 applied false, a revisão e o updatedAt atuais, sem gravar', async () => {
    const { service, calls } = makeSaveService(stored());

    const view = await service.save('bruno', 'd1', conference({ expectedRevision: 37 }));

    expect(view).toMatchObject({
      applied: false,
      replayed: false,
      revision: 38,
      updatedAt: '2026-11-14T13:05:40.000Z',
    });
    expect(calls()).toEqual([]);
  });

  it('a conferência vem antes do 409: o mesmo corpo com fatias seria REVISION_CONFLICT', async () => {
    const { service } = makeSaveService(stored());

    await expect(
      service.save('bruno', 'd1', conference({ expectedRevision: 37, slices: {} })),
    ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
  });

  it.each([
    ['setup', { setup: {} }],
    ['slices', { slices: {} }],
    ['items', { items: {} }],
  ])(
    'chave %s presente, mesmo vazia, não é regravação de conferência: revisão velha é 409',
    async (_key, extra) => {
      const { service } = makeSaveService(stored());

      await expect(
        service.save('bruno', 'd1', conference({ expectedRevision: 37, ...extra })),
      ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
    },
  );

  it('abrir em outro computador enquanto a Ana edita: as duas respondem 200 e a revisão termina em 41', async () => {
    const { service, manager } = makeSaveService(stored({ revision: 40 }));

    const bruno = await service.save('bruno', 'd1', conference({ expectedRevision: 40 }));
    const ana = await service.save(
      'ana',
      'd1',
      saveBody({ expectedRevision: 40, mutationId: 'A1', slices: { card: {} } }),
    );

    expect(bruno).toMatchObject({ applied: true, revision: 40 });
    expect(ana).toMatchObject({ applied: true, revision: 41 });
    expect(manager.findOne).toHaveBeenCalledTimes(2);
  });

  it('a chave setup, slices ou items presente com a revisão certa sobe a revisão (slices: {})', async () => {
    const { service } = makeSaveService(stored());

    const view = await service.save('bruno', 'd1', conference({ slices: {} }));

    expect(view).toMatchObject({ applied: true, revision: 39 });
  });
});
