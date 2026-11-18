import type { CreateFlyerProExportDto } from '../dto/create-flyer-pro-export.dto';
import { exportOptions } from '../testing/flyer-pro-exports.fixture';
import {
  ANA,
  commandsOf,
  DOCUMENT,
  exportRow,
  insertOf,
  OTHER_DOCUMENT,
  rejection,
  setupRegister as setup,
} from './flyer-pro-exports.service.testutil';

describe('FlyerProExportsService.register: ordem das conferências', () => {
  it('corpo {} é 400 com a lista dos que faltam, antes de abrir a transação', async () => {
    const { service, dataSource } = setup();

    await expect(
      service.register(DOCUMENT, {} as CreateFlyerProExportDto, ANA),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'BAD_REQUEST',
        message:
          'Campos obrigatórios ausentes: id, format, options, documentRevision, engineVersion, renderDigest, fileName.',
      },
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it.each([
    'id',
    'format',
    'options',
    'documentRevision',
    'engineVersion',
    'renderDigest',
    'fileName',
  ])('%s nulo é 400 com o campo na lista, nunca 500, antes de abrir a transação', async (field) => {
    const { register, dataSource } = setup();

    await expect(register({ [field]: null })).rejects.toMatchObject({
      status: 400,
      response: { code: 'BAD_REQUEST', message: `Campos obrigatórios ausentes: ${field}.` },
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('encarte excluído com regra quebrada (revisão 999) é 404, sem ler exportação', async () => {
    const { register, manager } = setup({ revision: null });

    await expect(register({ documentRevision: 999 })).rejects.toMatchObject(
      rejection(404, 'FLYER_PRO_NOT_FOUND'),
    );
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('repetição com corpo que hoje seria recusado (revisão 99): 200, e não 422', async () => {
    const { register } = setup({ revision: 41, existing: exportRow() });

    const { view, created } = await register({ documentRevision: 99 });

    expect(created).toBe(false);
    expect(view.replayed).toBe(true);
  });

  it('id de outro encarte com regra quebrada (png-450-sheet com duas folhas): 409, e não 422', async () => {
    const { register } = setup({ existing: exportRow({ documentId: OTHER_DOCUMENT }) });

    await expect(
      register({
        format: 'png',
        fileName: 'a.png',
        options: exportOptions({ preset: 'png-450-sheet', sheets: [1, 2] }),
      }),
    ).rejects.toMatchObject(rejection(409, 'FLYER_PRO_EXPORT_ID_CONFLICT'));
  });

  it('repetição num encarte excluído é 404, mesmo com a exportação gravada', async () => {
    const { register, manager } = setup({ revision: null, existing: exportRow() });

    await expect(register()).rejects.toMatchObject(rejection(404, 'FLYER_PRO_NOT_FOUND'));
    expect(insertOf(manager)).toBeUndefined();
  });
});

describe('FlyerProExportsService.register: não muda o encarte', () => {
  it('nova, repetida ou recusada, nenhum comando escreve fora de flyer_pro_exports e o encarte só é lido', async () => {
    const created = setup();
    const replayed = setup({ existing: exportRow() });
    const refused = setup();

    await created.register();
    await replayed.register();
    await refused.register({ documentRevision: 42 }).catch(() => undefined);

    for (const { manager } of [created, replayed, refused]) {
      for (const { sql } of commandsOf(manager)) expect(sql).not.toContain('flyer_pro_documents');
      expect(Object.keys(manager)).toEqual(['findOne', 'query']);
      expect(manager.findOne).toHaveBeenCalledTimes(1);
    }
  });
});
