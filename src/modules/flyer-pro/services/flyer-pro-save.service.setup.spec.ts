import { snapshotOf, STATUS } from './flyer-pro-documents.service.testutil';
import {
  columnsSetBy,
  makeSaveService,
  saveBody,
  storedDocument,
} from './flyer-pro-save.service.testutil';

const NEW_SNAPSHOT = { ...snapshotOf('54x40'), sceneId: 'scene-54' };

describe('FlyerProSaveService.save: o ramo setup', () => {
  it('passa o manager da transação, o encarte travado e o setup ao ramo, depois do carimbo', async () => {
    const { service, setup, manager } = makeSaveService();
    const stored = storedDocument();
    manager.findOne.mockResolvedValue(stored);

    await service.save('ana', 'd1', saveBody({ setup: { name: 'Novo' } }));

    expect(setup.apply).toHaveBeenCalledWith(manager, stored, { name: 'Novo' });
    const clock = manager.query.mock.calls.findIndex(([sql]) => sql.includes('clock_timestamp'));
    expect(manager.query.mock.invocationCallOrder[clock]).toBeLessThan(
      setup.apply.mock.invocationCallOrder[0],
    );
  });

  it('as colunas do setup entram no mesmo UPDATE da revisão e das fatias', async () => {
    const { service, setup, updates } = makeSaveService();
    setup.apply.mockResolvedValue({ name: 'Ofertas Piccin semana 48', pageCount: 4 });

    const view = await service.save(
      'ana',
      'd1',
      saveBody({ setup: { pageCount: 4 }, slices: { frame: {} } }),
    );

    expect(updates()).toHaveLength(1);
    expect(columnsSetBy(updates()[0])).toMatchObject({
      name: 'Ofertas Piccin semana 48',
      pageCount: 4,
      frame: '{}',
      revision: 38,
    });
    expect(view).toMatchObject({ revision: 38, pageCount: 4 });
  });

  it('só com setup.pageCount a resposta traz o pageCount e nada do template', async () => {
    const { service, setup, snapshots } = makeSaveService();
    setup.apply.mockResolvedValue({ pageCount: 4 });

    const view = await service.save('ana', 'd1', saveBody({ setup: { pageCount: 4 } }));

    expect(view.pageCount).toBe(4);
    for (const field of ['format', 'templateSnapshot', 'templateStatus']) {
      expect(view).not.toHaveProperty(field);
    }
    expect(snapshots.statusOf).not.toHaveBeenCalled();
  });

  it('com sceneId a resposta traz format, pageCount, templateSnapshot e o templateStatus da cópia nova', async () => {
    const { service, setup, snapshots, manager } = makeSaveService();
    setup.apply.mockResolvedValue({
      sceneId: 'scene-54',
      templateSnapshot: NEW_SNAPSHOT,
      format: '54x40',
      pageCount: 2,
    });

    const view = await service.save('ana', 'd1', saveBody({ setup: { sceneId: 'scene-54' } }));

    expect(snapshots.statusOf).toHaveBeenCalledWith(NEW_SNAPSHOT, manager);
    expect(view).toMatchObject({
      format: '54x40',
      pageCount: 2,
      templateSnapshot: NEW_SNAPSHOT,
      templateStatus: STATUS,
    });
  });

  it('refreshTemplate true também traz os quatro campos; false traz nenhum', async () => {
    const { service, setup } = makeSaveService();
    setup.apply.mockResolvedValue({ templateSnapshot: NEW_SNAPSHOT });

    const refreshed = await service.save(
      'ana',
      'd1',
      saveBody({ setup: { refreshTemplate: true } }),
    );
    const off = await service.save(
      'ana',
      'd1',
      saveBody({ setup: { refreshTemplate: false }, mutationId: 'M2' }),
    );

    expect(refreshed).toMatchObject({ templateSnapshot: NEW_SNAPSHOT });
    expect(off).not.toHaveProperty('templateSnapshot');
  });

  it('uma recusa do ramo derruba o corpo inteiro: nenhum UPDATE, a revisão não sobe', async () => {
    const { service, setup, updates } = makeSaveService();
    setup.apply.mockRejectedValue(new Error('cliente inexistente'));

    await expect(
      service.save('ana', 'd1', saveBody({ setup: { clientId: 'x' }, slices: { frame: {} } })),
    ).rejects.toThrow('cliente inexistente');
    expect(updates()).toEqual([]);
  });

  it('a regravação de conferência não chama o ramo', async () => {
    const { service, setup } = makeSaveService(storedDocument({ revision: 38 }));

    await service.save('ana', 'd1', saveBody({ expectedRevision: 38, layoutDigest: 'x' }));

    expect(setup.apply).not.toHaveBeenCalled();
  });
});

describe('FlyerProSaveService.save: reenvio de um corpo com troca de template', () => {
  const replaying = () =>
    makeSaveService(
      storedDocument({
        revision: 38,
        lastMutationId: 'M1',
        format: '54x40',
        pageCount: 2,
        templateSnapshot: NEW_SNAPSHOT,
      }),
    );

  it('com setup.sceneId traz os campos atuais: a cópia da coluna, sem montar de novo, e o status de agora', async () => {
    const { service, setup, snapshots, manager, calls } = replaying();

    const view = await service.save('ana', 'd1', saveBody({ setup: { sceneId: 'scene-54' } }));

    expect(view).toMatchObject({
      replayed: true,
      applied: true,
      revision: 38,
      format: '54x40',
      pageCount: 2,
      templateSnapshot: NEW_SNAPSHOT,
      templateStatus: STATUS,
    });
    expect(view.templateSnapshot.capturedAt).toBe(NEW_SNAPSHOT.capturedAt);
    expect(snapshots.statusOf).toHaveBeenCalledWith(NEW_SNAPSHOT, manager);
    expect(setup.apply).not.toHaveBeenCalled();
    expect(calls()).toEqual([]);
  });

  it('Atualizar arte reenviado traz os mesmos quatro campos', async () => {
    const { service } = replaying();

    const view = await service.save('ana', 'd1', saveBody({ setup: { refreshTemplate: true } }));

    expect(view).toMatchObject({ templateSnapshot: NEW_SNAPSHOT, format: '54x40', pageCount: 2 });
  });

  it('só com setup.pageCount traz o pageCount atual, sem template', async () => {
    const { service, snapshots } = replaying();

    const view = await service.save('ana', 'd1', saveBody({ setup: { pageCount: 4 } }));

    expect(view.pageCount).toBe(2);
    expect(view).not.toHaveProperty('templateSnapshot');
    expect(snapshots.statusOf).not.toHaveBeenCalled();
  });

  it('um corpo sem setup não traz nenhum dos campos', async () => {
    const { service } = replaying();

    const view = await service.save('ana', 'd1', saveBody({ slices: { card: {} } }));

    expect(view).not.toHaveProperty('pageCount');
  });
});
