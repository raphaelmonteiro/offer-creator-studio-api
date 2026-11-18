import {
  activeJobViolation,
  ANA,
  DOC,
  jobRow,
  makeJobsService,
} from './flyer-pro-jobs.service.testutil';

const ITEM = '11111111-1111-4111-8111-111111111111';
const STEPS = ['categorize', 'spellcheck', 'image_match'];

describe('FlyerProJobsService.requestAfterSave (o job pedido no salvar)', () => {
  const withItems = {
    itemIdsInDocument: [ITEM],
    counts: { categorize: 78, spellcheck: 78, image_match: 78 },
  };

  it('Importação que já pede o job: nasce queued com total 234, onlyMissing e autoApply ligados e todos os itens', async () => {
    const { service, manager, inserted, queue } = makeJobsService(withItems);

    const outcome = await service.requestAfterSave(manager, ANA, DOC, STEPS);

    expect(outcome.started).toBe(true);
    expect(outcome.job).toMatchObject({ status: 'queued', total: 234 });
    expect(inserted[0]).toMatchObject({
      onlyMissing: true,
      autoApply: true,
      itemIds: null,
      steps: STEPS,
    });
    expect(queue.publish).toHaveBeenCalledTimes(1);
  });

  it('job ativo: nenhum job novo, started false com o job em andamento', async () => {
    const running = jobRow({ id: 'ativo', status: 'running' });
    const { service, manager, inserted, queue } = makeJobsService({
      ...withItems,
      active: running,
    });

    const outcome = await service.requestAfterSave(manager, ANA, DOC, STEPS);

    expect(outcome).toMatchObject({ started: false, job: { id: 'ativo', status: 'running' } });
    expect(inserted).toEqual([]);
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('flag desligada: grava sem job, started false e o job ativo ou null', async () => {
    const off = makeJobsService(withItems, { enabled: false });
    expect(await off.service.requestAfterSave(off.manager, ANA, DOC, STEPS)).toEqual({
      started: false,
      job: null,
    });
    const offWithActive = makeJobsService(
      { ...withItems, active: jobRow({ id: 'ativo', status: 'running' }) },
      { enabled: false },
    );

    const outcome = await offWithActive.service.requestAfterSave(
      offWithActive.manager,
      ANA,
      DOC,
      STEPS,
    );

    expect(outcome.job?.id).toBe('ativo');
    expect(offWithActive.inserted).toEqual([]);
  });

  it('Salvar que apaga todos os itens: started false e job null, sem criar', async () => {
    const { service, manager, inserted } = makeJobsService({ itemIdsInDocument: [] });

    expect(await service.requestAfterSave(manager, ANA, DOC, STEPS)).toEqual({
      started: false,
      job: null,
    });
    expect(inserted).toEqual([]);
  });

  describe('falha ao criar o job no salvar (savepoint)', () => {
    it('Fila indisponível: só a criação é desfeita; started false, job null, e a transação segue', async () => {
      const { service, queue, manager: m } = makeJobsService(withItems);
      queue.publish.mockRejectedValue(new Error('Fila não inicializada'));

      const outcome = await service.requestAfterSave(m, ANA, DOC, STEPS);

      expect(outcome).toEqual({ started: false, job: null });
      const sql = m.query.mock.calls.map(([text]) => String(text));
      expect(sql).toContain('SAVEPOINT flyer_pro_enrich_job');
      expect(sql).toContain('ROLLBACK TO SAVEPOINT flyer_pro_enrich_job');
      expect(sql).not.toContain('RELEASE SAVEPOINT flyer_pro_enrich_job');
    });

    it('Corrida com o pedido manual: o 23505 do índice vira started false com o job do outro pedido', async () => {
      const winner = jobRow({ id: 'do-n14', status: 'queued' });
      const world = makeJobsService(withItems);
      world.manager.insert.mockImplementationOnce(async () => {
        world.state.active = winner;
        throw activeJobViolation();
      });

      const outcome = await world.service.requestAfterSave(world.manager, ANA, DOC, STEPS);

      expect(outcome).toMatchObject({ started: false, job: { id: 'do-n14' } });
    });

    it('sucesso libera o savepoint', async () => {
      const { service, manager: m } = makeJobsService(withItems);

      await service.requestAfterSave(m, ANA, DOC, STEPS);

      const sql = m.query.mock.calls.map(([text]) => String(text));
      expect(sql).toContain('RELEASE SAVEPOINT flyer_pro_enrich_job');
    });
  });

  describe('replayAfterSave (reenvio com replayed true)', () => {
    it.each([
      [
        'o ativo',
        { active: jobRow({ id: 'ativo', status: 'running' }), latest: jobRow({ id: 'velho' }) },
        'ativo',
      ],
      [
        'o mais recente, sem ativo',
        { latest: jobRow({ id: 'recente', status: 'done' }) },
        'recente',
      ],
      ['nenhum', {}, undefined],
    ])('mostra %s, sem criar job', async (_, world, id) => {
      const { service, manager: m, inserted } = makeJobsService(world);

      const outcome = await service.replayAfterSave(m, DOC);

      expect(outcome.started).toBe(false);
      expect(outcome.job?.id).toBe(id);
      expect(inserted).toEqual([]);
    });
  });
});
