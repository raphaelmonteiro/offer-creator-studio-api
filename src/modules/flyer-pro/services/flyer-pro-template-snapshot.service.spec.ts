import { entryInput, SCENE_ID } from '../domain/flyer-pro-template-entry.testutil';
import { toTemplateEntry, analyzeSceneTemplate } from '../domain/flyer-pro-template-entry';
import { failureOf, snapshotServiceFor } from './flyer-pro-template-snapshot.testutil';

const frontBack = { scene: { layout: 'front_back' } } as const;
const tabloid = { scene: { formatId: 'folheto-54x40', layout: 'tabloid' } } as const;

describe('FlyerProTemplateSnapshotService.build', () => {
  describe('a cópia de uma cena pronta', () => {
    beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-11-16T10:00:00.000Z')));
    afterEach(() => jest.useRealTimers());

    it('traz v 1, a cena, o formato, a dobra, o layout, as faces, a revisão e a hora da cópia', async () => {
      const input = entryInput({ ...frontBack, scene: { layout: 'front_back', name: 'Páscoa' } });
      const { service } = snapshotServiceFor(input);
      const snapshot = await service.build(SCENE_ID);
      expect(snapshot).toEqual({
        v: 1,
        sceneId: SCENE_ID,
        name: 'Páscoa',
        format: '27x40',
        fold: 'simple',
        layout: 'front_back',
        faces: toTemplateEntry(analyzeSceneTemplate(input))?.faces,
        sceneRevision: 5,
        capturedAt: '2026-11-16T10:00:00.000Z',
      });
      expect(snapshot.faces.map((face) => face.key)).toEqual(['front', 'back']);
    });

    it('não traz os campos só da lista', async () => {
      const { service } = snapshotServiceFor(entryInput());
      const keys = Object.keys(await service.build(SCENE_ID));
      for (const key of [
        'pageOptions',
        'defaultPageCount',
        'usable',
        'unusableReason',
        'missingFaces',
        'thumbnailUrl',
        'updatedAt',
      ]) {
        expect(keys).not.toContain(key);
      }
    });

    it('montar duas vezes dá as mesmas faces; só o capturedAt pode diferir', async () => {
      const { service } = snapshotServiceFor(entryInput(frontBack));
      const first = await service.build(SCENE_ID);
      jest.setSystemTime(new Date('2026-11-16T10:05:00.000Z'));
      const second = await service.build(SCENE_ID);
      expect({ ...second, capturedAt: '' }).toEqual({ ...first, capturedAt: '' });
      expect(second.capturedAt).not.toBe(first.capturedAt);
    });
  });

  describe('não grava e lê onde pedem', () => {
    it('nenhuma chamada de escrita, na montagem pronta e na recusada', async () => {
      const ok = snapshotServiceFor(entryInput());
      await ok.service.build(SCENE_ID, ok.manager);
      const refused = snapshotServiceFor(entryInput({ ...frontBack, ready: ['front'] }));
      await failureOf(refused.service.build(SCENE_ID, refused.manager));
      expect(ok.writesCalled()).toEqual([]);
      expect(refused.writesCalled()).toEqual([]);
    });

    it('com o manager de quem chama: lê por ele, sem abrir transação própria', async () => {
      const { service, reader, manager, transaction } = snapshotServiceFor(entryInput());
      await service.build(SCENE_ID, manager);
      expect(transaction).not.toHaveBeenCalled();
      expect(reader.findScene).toHaveBeenCalledWith(manager, SCENE_ID);
      expect(reader.faceRows).toHaveBeenCalledWith(manager, [SCENE_ID]);
    });

    it('sem manager: lê numa transação REPEATABLE READ própria', async () => {
      const { service, reader, manager, transaction } = snapshotServiceFor(entryInput());
      await service.build(SCENE_ID);
      expect(transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
      expect(reader.findScene).toHaveBeenCalledWith(manager, SCENE_ID);
    });
  });

  describe('as recusas, na ordem: 404, 422 UNSUPPORTED, 422 INCOMPLETE', () => {
    const notFound = {
      status: 404,
      body: { code: 'FLYER_PRO_TEMPLATE_NOT_FOUND', message: 'Template não encontrado.' },
    };

    it('cena que não existe: 404 FLYER_PRO_TEMPLATE_NOT_FOUND', async () => {
      const { service } = snapshotServiceFor(null);
      expect(await failureOf(service.build(SCENE_ID))).toEqual(notFound);
    });

    it('cena excluída com o template ainda existente: 404', async () => {
      const input = entryInput({ scene: { deletedAt: new Date('2026-11-14T00:00:00.000Z') } });
      expect(await failureOf(snapshotServiceFor(input).service.build(SCENE_ID))).toEqual(notFound);
    });

    it('cena sem nenhuma face pronta vem antes do layout: o "teste" 54x40 de face única sem template é 404, e não 422', async () => {
      const input = entryInput({
        scene: { formatId: 'folheto-54x40', layout: 'single' },
        ready: [],
      });
      expect(await failureOf(snapshotServiceFor(input).service.build(SCENE_ID))).toEqual(notFound);
    });

    it('formato fora com a face pronta: 422 UNSUPPORTED com reason FORMAT', async () => {
      const input = entryInput({ scene: { formatId: 'folheto-20x27' } });
      expect(await failureOf(snapshotServiceFor(input).service.build(SCENE_ID))).toEqual({
        status: 422,
        body: {
          code: 'FLYER_PRO_TEMPLATE_UNSUPPORTED',
          message: 'Este template não pode ser usado no Encarte Pro.',
          details: { reason: 'FORMAT', formatId: 'folheto-20x27', layout: 'single' },
        },
      });
    });

    it('54x40 de face única com a face pronta: 422 UNSUPPORTED com reason LAYOUT', async () => {
      const input = entryInput({ scene: { formatId: 'folheto-54x40', layout: 'single' } });
      const failure = await failureOf(snapshotServiceFor(input).service.build(SCENE_ID));
      expect(failure.status).toBe(422);
      expect(failure.body).toEqual(
        expect.objectContaining({
          code: 'FLYER_PRO_TEMPLATE_UNSUPPORTED',
          details: { reason: 'LAYOUT', formatId: 'folheto-54x40', layout: 'single' },
        }),
      );
    });

    it('face faltando: 422 INCOMPLETE com a mensagem do cartão e as faces que faltam', async () => {
      const input = entryInput({ ...frontBack, ready: ['front'] });
      expect(await failureOf(snapshotServiceFor(input).service.build(SCENE_ID))).toEqual({
        status: 422,
        body: {
          code: 'FLYER_PRO_TEMPLATE_INCOMPLETE',
          message: 'Este template ainda não tem todas as faces prontas.',
          details: { missingFaces: ['back'] },
        },
      });
    });

    it('jornal só com a Externa: missingFaces ["inner"]', async () => {
      const input = entryInput({ ...tabloid, ready: ['outer'] });
      const failure = await failureOf(snapshotServiceFor(input).service.build(SCENE_ID));
      expect(failure.body).toEqual(
        expect.objectContaining({ details: { missingFaces: ['inner'] } }),
      );
    });

    it('template do Verso apagado: INCOMPLETE com ["back"]', async () => {
      const input = entryInput({ ...frontBack, ready: ['front'], faces: ['front', 'back'] });
      const failure = await failureOf(snapshotServiceFor(input).service.build(SCENE_ID));
      expect(failure.body).toEqual(
        expect.objectContaining({ details: { missingFaces: ['back'] } }),
      );
    });

    it('UNSUPPORTED vem antes de INCOMPLETE: 27x40 com o layout do jornal e só uma face pronta é LAYOUT', async () => {
      const input = entryInput({
        scene: { layout: 'tabloid' },
        faces: ['outer', 'inner'],
        ready: ['outer'],
      });
      const failure = await failureOf(snapshotServiceFor(input).service.build(SCENE_ID));
      expect(failure.body).toEqual(
        expect.objectContaining({
          code: 'FLYER_PRO_TEMPLATE_UNSUPPORTED',
          details: expect.objectContaining({ reason: 'LAYOUT' }),
        }),
      );
    });
  });
});
