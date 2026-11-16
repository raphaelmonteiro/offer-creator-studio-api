import type { DataSource, EntityManager } from 'typeorm';
import {
  entryInput,
  faceRow,
  SCENE_ID,
  templateRow,
} from '../domain/flyer-pro-template-entry.testutil';
import { FlyerProSceneReader } from './flyer-pro-scene.reader';
import { FlyerProTemplatesService } from './flyer-pro-templates.service';

function setup(scenesOfPage = [entryInput({ scene: { layout: 'front_back' } })], total = 1) {
  const manager = {} as EntityManager;
  const transaction = jest.fn((_isolation: string, work: (m: EntityManager) => unknown) =>
    work(manager),
  );
  const reader = {
    listPage: jest.fn().mockResolvedValue({ scenes: scenesOfPage.map((i) => i.scene), total }),
    faceRows: jest.fn().mockResolvedValue(scenesOfPage.flatMap((i) => i.faces)),
    templateRows: jest.fn().mockResolvedValue([...scenesOfPage[0].templates.values()]),
  };
  const service = new FlyerProTemplatesService(
    { transaction } as unknown as DataSource,
    reader as unknown as FlyerProSceneReader,
  );
  return { service, reader, transaction, manager };
}

describe('FlyerProTemplatesService.list', () => {
  it('sem filtros: página 1, limite 20, os dois formatos, e o envelope de paginação', async () => {
    const { service, reader, manager } = setup();
    const result = await service.list({});
    expect(reader.listPage).toHaveBeenCalledWith(manager, {
      formatIds: ['folheto-27x40', 'folheto-54x40'],
      search: undefined,
      sceneId: undefined,
      page: 1,
      limit: 20,
    });
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    expect(result.data.map((entry) => entry.sceneId)).toEqual([SCENE_ID]);
  });

  it('format vira o id de formato da cena e os filtros e a página passam adiante', async () => {
    const { service, reader } = setup();
    await service.list({ format: '54x40', search: 'abc', sceneId: SCENE_ID, page: 2, limit: 5 });
    expect(reader.listPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        formatIds: ['folheto-54x40'],
        search: 'abc',
        sceneId: SCENE_ID,
        page: 2,
        limit: 5,
      }),
    );
  });

  it('as faces e os templates vêm em uma consulta cada, para a página inteira (sem N+1)', async () => {
    const first = entryInput({ scene: { layout: 'front_back' } });
    const second = entryInput({ scene: { id: 'cena-2', layout: 'single' } });
    second.faces = [faceRow('single', { sceneId: 'cena-2', templateId: 'tpl-b' })];
    second.templates.clear();
    second.templates.set('tpl-b', templateRow('single', { id: 'tpl-b' }));
    const { service, reader } = setup([first, second], 2);
    reader.templateRows.mockResolvedValue([
      ...first.templates.values(),
      ...second.templates.values(),
    ]);
    const result = await service.list({});
    expect(reader.faceRows).toHaveBeenCalledTimes(1);
    expect(reader.templateRows).toHaveBeenCalledTimes(1);
    expect(reader.templateRows.mock.calls[0][1].sort()).toEqual(
      ['tpl-back', 'tpl-b', 'tpl-front'].sort(),
    );
    expect(result.data.map((entry) => entry.sceneId)).toEqual([SCENE_ID, 'cena-2']);
  });

  it('as leituras de uma chamada rodam numa transação REPEATABLE READ (A-10 b)', async () => {
    const { service, transaction } = setup();
    await service.list({});
    expect(transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
  });

  it('página além do fim: data vazio e o total e as páginas reais, sem consultar faces nem templates', async () => {
    const { service, reader } = setup([entryInput()], 5);
    reader.listPage.mockResolvedValue({ scenes: [], total: 5 });
    const result = await service.list({ page: 9 });
    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({ page: 9, limit: 20, total: 5, totalPages: 1 });
    expect(reader.faceRows).not.toHaveBeenCalled();
    expect(reader.templateRows).not.toHaveBeenCalled();
  });

  it('páginas pelo total e pelo limite: 5 cenas com limit 2 são 3 páginas', async () => {
    const { service } = setup([entryInput()], 5);
    const result = await service.list({ page: 2, limit: 2 });
    expect(result.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
  });
});
