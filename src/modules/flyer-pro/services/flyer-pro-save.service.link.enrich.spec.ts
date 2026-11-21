import { PHOTO } from '../testing/flyer-pro-photo-group.testutil';
import { ABACATE } from './flyer-pro-items.service.testutil';
import {
  makeSavingPhoto,
  PHOTO_CHOICE,
  photoBody,
  recordSaveOrder,
  SAVED_ABACATE,
} from './flyer-pro-save.service.link.testutil';
import { storedDocument } from './flyer-pro-save.service.testutil';

/**
 * O registro da foto (change 27) convivendo com o passo do job (change 28) no mesmo `PATCH`: o job nasce dentro da
 * transação, o registro corre depois do commit, e a resposta leva `enrichment` e `linkWarnings`.
 */
const ENRICH = { steps: ['categorize', 'spellcheck', 'image_match'] };
const started = { started: true, job: { id: 'job-1', status: 'queued', total: 234 } };
const replayed = { started: false, job: { id: 'job-1', status: 'running', total: 234 } };

describe('FlyerProSaveService.save: foto e enrich no mesmo PATCH', () => {
  it('pede o job dentro da transação, registra depois dela e responde com enrichment e linkWarnings', async () => {
    const made = makeSavingPhoto();
    const { service, manager, jobs, links } = made;
    const order = recordSaveOrder(made);
    jobs.requestAfterSave.mockImplementation(async () => {
      order.push('job');
      return started;
    });

    const view = await service.save('ana', 'd1', photoBody({ enrich: ENRICH }));

    expect(order).toEqual(['job', 'commit', 'register']);
    expect(jobs.requestAfterSave).toHaveBeenCalledWith(manager, 'ana', 'd1', ENRICH.steps);
    expect(links.register).toHaveBeenCalledWith({
      choices: [PHOTO_CHOICE],
      items: [SAVED_ABACATE],
      clientId: 'c1',
    });
    expect(view).toMatchObject({
      revision: 38,
      applied: true,
      enrichment: started,
      linkWarnings: [],
    });
    expect(view.items[0]).toMatchObject({
      id: ABACATE,
      galleryImageId: PHOTO,
      imageOrigin: 'picker',
    });
  });

  it('a falha do registro não muda o enrichment nem a revisão', async () => {
    const { service, jobs, links } = makeSavingPhoto();
    jobs.requestAfterSave.mockResolvedValue(started);
    links.register.mockResolvedValue([{ itemId: ABACATE, code: 'GALLERY_LINK_FAILED' }]);

    const view = await service.save('ana', 'd1', photoBody({ enrich: ENRICH }));

    expect(view.revision).toBe(38);
    expect(view.enrichment).toEqual(started);
    expect(view.linkWarnings).toEqual([{ itemId: ABACATE, code: 'GALLERY_LINK_FAILED' }]);
  });

  it('sem enrich no corpo, a resposta tem linkWarnings e não tem a chave enrichment', async () => {
    const { service, jobs } = makeSavingPhoto();

    const view = await service.save('ana', 'd1', photoBody());

    expect(jobs.requestAfterSave).not.toHaveBeenCalled();
    expect(view.linkWarnings).toEqual([]);
    expect(view).not.toHaveProperty('enrichment');
  });

  it('o reenvio do mesmo mutationId com enrich: replayAfterSave, nenhum registro e linkWarnings vazio', async () => {
    const { service, jobs, links } = makeSavingPhoto(storedDocument({ lastMutationId: 'M1' }));
    jobs.replayAfterSave.mockResolvedValue(replayed);

    const view = await service.save('ana', 'd1', photoBody({ mutationId: 'M1', enrich: ENRICH }));

    expect(view).toMatchObject({ replayed: true, enrichment: replayed, linkWarnings: [] });
    expect(jobs.replayAfterSave).toHaveBeenCalledTimes(1);
    expect(jobs.requestAfterSave).not.toHaveBeenCalled();
    expect(links.register).not.toHaveBeenCalled();
  });
});
