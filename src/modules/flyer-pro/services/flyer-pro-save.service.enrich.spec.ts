import { HttpException } from '@nestjs/common';
import { makeSaveService, saveBody, storedDocument } from './flyer-pro-save.service.testutil';

const ENRICH = { steps: ['categorize', 'spellcheck', 'image_match'] };
const started = { started: true, job: { id: 'job-1', status: 'queued', total: 234 } };

const codeOf = (error: unknown): string => (error as HttpException).getResponse()['code'];

describe('FlyerProSaveService.save: o passo do job (enrich)', () => {
  it('Importação que já pede o job: depois de gravar o encarte, com o manager, o usuário e as fases do corpo', async () => {
    const { service, jobs, manager, updates } = makeSaveService();
    jobs.requestAfterSave.mockResolvedValue(started);

    const view = await service.save(
      'ana',
      'd1',
      saveBody({ items: { upsert: [] }, enrich: ENRICH }),
    );

    expect(jobs.requestAfterSave).toHaveBeenCalledWith(manager, 'ana', 'd1', ENRICH.steps);
    expect(view).toMatchObject({
      revision: 38,
      replayed: false,
      applied: true,
      enrichment: started,
    });
    expect(updates()).toHaveLength(1);
  });

  it('o passo do job roda depois do UPDATE do encarte', async () => {
    const { service, jobs, manager } = makeSaveService();
    const order: string[] = [];
    manager.query.mockImplementation((sql: string) => {
      if (sql.startsWith('UPDATE')) order.push('update');
      if (sql.includes('clock_timestamp')) return Promise.resolve([{ stamp: 'x' }]);
      return Promise.resolve(sql.startsWith('UPDATE') ? [[{ updatedAt: new Date() }], 1] : [[], 0]);
    });
    jobs.requestAfterSave.mockImplementation(async () => {
      order.push('job');
      return started;
    });

    await service.save('ana', 'd1', saveBody({ enrich: ENRICH }));

    expect(order).toEqual(['update', 'job']);
  });

  it('salvar sem enrich: a resposta não tem a chave enrichment, e nenhum job nasce', async () => {
    const { service, jobs } = makeSaveService();

    const view = await service.save('ana', 'd1', saveBody({ slices: { card: {} } }));

    expect(view).not.toHaveProperty('enrichment');
    expect(jobs.requestAfterSave).not.toHaveBeenCalled();
    expect(jobs.replayAfterSave).not.toHaveBeenCalled();
  });

  it('o resultado do passo (started false com o job ativo, ou job nulo) vai como está na resposta', async () => {
    const { service, jobs } = makeSaveService();
    const running = { started: false, job: { id: 'job-ativo', status: 'running' } };
    jobs.requestAfterSave
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({ started: false, job: null });

    expect((await service.save('ana', 'd1', saveBody({ enrich: ENRICH }))).enrichment).toEqual(
      running,
    );
    expect((await service.save('ana', 'd1', saveBody({ enrich: ENRICH }))).enrichment).toEqual({
      started: false,
      job: null,
    });
  });

  describe('reenvio do corpo que criou o job', () => {
    it('mesmo mutationId: nenhum job novo, replayed true e enrichment com o job que o encarte mostra', async () => {
      const { service, jobs } = makeSaveService(storedDocument({ lastMutationId: 'M1' }));
      const current = { started: false, job: { id: 'job-1', status: 'done' } };
      jobs.replayAfterSave.mockResolvedValue(current);

      const view = await service.save('ana', 'd1', saveBody({ mutationId: 'M1', enrich: ENRICH }));

      expect(view).toMatchObject({ replayed: true, applied: true, enrichment: current });
      expect(jobs.replayAfterSave).toHaveBeenCalledWith(expect.anything(), 'd1');
      expect(jobs.requestAfterSave).not.toHaveBeenCalled();
    });

    it('reenvio sem enrich: a resposta não traz enrichment', async () => {
      const { service, jobs } = makeSaveService(storedDocument({ lastMutationId: 'M1' }));

      const view = await service.save('ana', 'd1', saveBody({ mutationId: 'M1' }));

      expect(view).not.toHaveProperty('enrichment');
      expect(jobs.replayAfterSave).not.toHaveBeenCalled();
    });
  });

  describe('recusa do salvar não cria job', () => {
    it('revisão desatualizada: 409 REVISION_CONFLICT e nenhum job', async () => {
      const { service, jobs } = makeSaveService(storedDocument({ revision: 38 }));

      const error = await service
        .save('ana', 'd1', saveBody({ expectedRevision: 37, enrich: ENRICH }))
        .catch((e: unknown) => e);

      expect(codeOf(error)).toBe('REVISION_CONFLICT');
      expect(jobs.requestAfterSave).not.toHaveBeenCalled();
    });

    it('item inválido (422): nada é gravado e nenhum job é pedido', async () => {
      const { service, jobs, items, updates } = makeSaveService(storedDocument({ revision: 38 }));
      items.apply.mockRejectedValue(new HttpException({ code: 'FLYER_PRO_ITEM_INVALID' }, 422));

      const error = await service
        .save(
          'ana',
          'd1',
          saveBody({ expectedRevision: 38, items: { upsert: [] }, enrich: ENRICH }),
        )
        .catch((e: unknown) => e);

      expect(codeOf(error)).toBe('FLYER_PRO_ITEM_INVALID');
      expect(jobs.requestAfterSave).not.toHaveBeenCalled();
      expect(updates()).toEqual([]);
    });

    it('corpo só com enrich na revisão errada: 409, e não 200 com applied false', async () => {
      const { service } = makeSaveService(storedDocument({ revision: 38 }));

      const error = await service
        .save('ana', 'd1', saveBody({ expectedRevision: 37, layoutDigest: 'x', enrich: ENRICH }))
        .catch((e: unknown) => e);

      expect(codeOf(error)).toBe('REVISION_CONFLICT');
    });
  });

  it('corpo só com enrich na revisão certa não é regravação de conferência: grava a revisão e pede o job', async () => {
    const { service, jobs, updates } = makeSaveService(storedDocument({ revision: 37 }));
    jobs.requestAfterSave.mockResolvedValue(started);

    const view = await service.save('ana', 'd1', saveBody({ enrich: ENRICH }));

    expect(view).toMatchObject({ revision: 38, applied: true });
    expect(updates()).toHaveLength(1);
    expect(jobs.requestAfterSave).toHaveBeenCalledTimes(1);
  });
});
