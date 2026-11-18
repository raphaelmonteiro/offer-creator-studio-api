import { HttpException, HttpStatus } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  flyerProTemplateIncomplete,
  flyerProTemplateNotFound,
  flyerProTemplateUnsupported,
} from '../domain/flyer-pro.errors';
import type { FlyerProSetupPatchDto } from '../dto/flyer-pro-setup-patch.dto';
import { documentRow, snapshotOf } from './flyer-pro-documents.service.testutil';
import { FlyerProSetupService } from './flyer-pro-setup.service';
import type { FlyerProTemplateSnapshotService } from './flyer-pro-template-snapshot.service';

const NEW_SCENE = '9eb30a72-aa45-41c1-9832-2733d6a39277';
const CLIENT = 'c2e28b36-5c8e-4fa0-9f37-7c3357ac8487';

function makeSetup(clientExists = true) {
  const manager = { query: jest.fn().mockResolvedValue(clientExists ? [{ '?column?': 1 }] : []) };
  const snapshots = { build: jest.fn().mockResolvedValue(snapshotOf('27x40')) };
  const service = new FlyerProSetupService(snapshots as unknown as FlyerProTemplateSnapshotService);
  const apply = (setup: FlyerProSetupPatchDto, document = documentRow()) =>
    service.apply(manager as unknown as EntityManager, document, setup);
  return { apply, manager, snapshots };
}

const setupOf = (over: FlyerProSetupPatchDto): FlyerProSetupPatchDto => over;

async function refusalOf(promise: Promise<unknown>) {
  const error = (await promise.then(
    () => null,
    (caught: unknown) => caught,
  )) as HttpException;
  const body = error.getResponse() as { code: string; details?: unknown };
  return { status: error.getStatus(), code: body.code, details: body.details };
}

describe('FlyerProSetupService.apply: nome e cliente', () => {
  it('grava o nome do Setup', async () => {
    const { apply } = makeSetup();

    await expect(apply(setupOf({ name: 'Ofertas Piccin semana 48' }))).resolves.toEqual({
      name: 'Ofertas Piccin semana 48',
    });
  });

  it('grava o cliente só se ele existir, conferindo pelo manager da transação', async () => {
    const { apply, manager } = makeSetup();

    await expect(apply(setupOf({ clientId: CLIENT }))).resolves.toEqual({ clientId: CLIENT });
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('FROM clients'), [CLIENT]);
  });

  it('cliente inexistente: 404 CLIENT_NOT_FOUND "Cliente não encontrado", e a cena nem é montada', async () => {
    const { apply, snapshots } = makeSetup(false);

    await expect(
      refusalOf(apply(setupOf({ clientId: CLIENT, sceneId: NEW_SCENE }))),
    ).resolves.toMatchObject({ status: 404, code: 'CLIENT_NOT_FOUND' });
    expect(snapshots.build).not.toHaveBeenCalled();
  });

  it('setup: {} não muda nada', async () => {
    const { apply, snapshots } = makeSetup();

    await expect(apply(setupOf({}))).resolves.toEqual({});
    expect(snapshots.build).not.toHaveBeenCalled();
  });
});

describe('FlyerProSetupService.apply: troca de template e Atualizar arte', () => {
  it('sceneId monta a cópia pelo manager da transação e grava sceneId, templateSnapshot e format', async () => {
    const { apply, snapshots, manager } = makeSetup();
    const snapshot = { ...snapshotOf('27x40'), sceneId: NEW_SCENE };
    snapshots.build.mockResolvedValue(snapshot);

    const columns = await apply(setupOf({ sceneId: NEW_SCENE }));

    expect(snapshots.build).toHaveBeenCalledWith(NEW_SCENE, manager);
    expect(columns).toEqual({ sceneId: NEW_SCENE, templateSnapshot: snapshot, format: '27x40' });
  });

  it('os três erros do montador passam como vêm: 404, 422 UNSUPPORTED e 422 INCOMPLETE', async () => {
    const { apply, snapshots } = makeSetup();
    const cases = [
      [flyerProTemplateNotFound(), 404, 'FLYER_PRO_TEMPLATE_NOT_FOUND'],
      [
        flyerProTemplateUnsupported({
          reason: 'FORMAT',
          formatId: 'folheto-20x27',
          layout: 'single',
        }),
        422,
        'FLYER_PRO_TEMPLATE_UNSUPPORTED',
      ],
      [flyerProTemplateIncomplete(['back']), 422, 'FLYER_PRO_TEMPLATE_INCOMPLETE'],
    ] as const;
    for (const [error, status, code] of cases) {
      snapshots.build.mockRejectedValueOnce(error);
      await expect(refusalOf(apply(setupOf({ sceneId: NEW_SCENE })))).resolves.toMatchObject({
        status,
        code,
      });
    }
  });

  it('Atualizar arte: refreshTemplate true remonta a cena atual', async () => {
    const { apply, snapshots, manager } = makeSetup();
    const document = documentRow({ sceneId: 'scene-atual' });

    const columns = await apply(setupOf({ refreshTemplate: true }), document);

    expect(snapshots.build).toHaveBeenCalledWith('scene-atual', manager);
    expect(columns).toMatchObject({ sceneId: 'scene-atual', format: '27x40' });
  });

  it('com sceneId e refreshTemplate no mesmo corpo vale o sceneId', async () => {
    const { apply, snapshots, manager } = makeSetup();

    await apply(setupOf({ refreshTemplate: true, sceneId: NEW_SCENE }), documentRow());

    expect(snapshots.build).toHaveBeenCalledTimes(1);
    expect(snapshots.build).toHaveBeenCalledWith(NEW_SCENE, manager);
  });

  it('refreshTemplate false não remonta nada e não grava cópia', async () => {
    const { apply, snapshots } = makeSetup();

    await expect(apply(setupOf({ refreshTemplate: false }))).resolves.toEqual({});
    expect(snapshots.build).not.toHaveBeenCalled();
  });

  it('cena excluída no Atualizar arte: o 404 do montador sobe e nada é devolvido para gravar', async () => {
    const { apply, snapshots } = makeSetup();
    snapshots.build.mockRejectedValue(flyerProTemplateNotFound());

    await expect(refusalOf(apply(setupOf({ refreshTemplate: true })))).resolves.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      code: 'FLYER_PRO_TEMPLATE_NOT_FOUND',
    });
  });
});

describe('FlyerProSetupService.apply: dobra travada pelas páginas congeladas', () => {
  it('outro formato com pagesFrozen: 422 FLYER_PRO_FOLD_LOCKED com o formato atual e o novo', async () => {
    const { apply, snapshots } = makeSetup();
    snapshots.build.mockResolvedValue(snapshotOf('54x40'));

    await expect(
      refusalOf(apply(setupOf({ sceneId: NEW_SCENE }), documentRow({ pagesFrozen: true }))),
    ).resolves.toEqual({
      status: 422,
      code: 'FLYER_PRO_FOLD_LOCKED',
      details: { format: '27x40', newFormat: '54x40' },
    });
  });

  it('mesmo formato com pagesFrozen é permitido, mantém o número de páginas e não mexe em pagesFrozen', async () => {
    const { apply } = makeSetup();

    const columns = await apply(
      setupOf({ sceneId: NEW_SCENE }),
      documentRow({ pagesFrozen: true, pageCount: 2 }),
    );

    expect(columns).toMatchObject({ format: '27x40' });
    expect(columns).not.toHaveProperty('pageCount');
    expect(columns).not.toHaveProperty('pagesFrozen');
  });

  it('outro formato com as páginas soltas é permitido', async () => {
    const { apply, snapshots } = makeSetup();
    snapshots.build.mockResolvedValue(snapshotOf('54x40'));

    await expect(apply(setupOf({ sceneId: NEW_SCENE }), documentRow())).resolves.toMatchObject({
      format: '54x40',
    });
  });
});

describe('FlyerProSetupService.apply: número de páginas pelo formato', () => {
  it('trocar para outro formato sem pageCount volta ao padrão do formato novo: 27x40 com 3 vai a 2 no 54x40', async () => {
    const { apply, snapshots } = makeSetup();
    snapshots.build.mockResolvedValue(snapshotOf('54x40'));

    const columns = await apply(setupOf({ sceneId: NEW_SCENE }), documentRow({ pageCount: 3 }));

    expect(columns).toMatchObject({ format: '54x40', pageCount: 2 });
  });

  it('trocar para o 27x40 vindo do 54x40 volta a 1 página', async () => {
    const { apply } = makeSetup();

    const columns = await apply(
      setupOf({ sceneId: NEW_SCENE }),
      documentRow({ format: '54x40', pageCount: 4 }),
    );

    expect(columns).toMatchObject({ format: '27x40', pageCount: 1 });
  });

  it('outro formato com pageCount no mesmo corpo vale o do corpo (4 no 54x40)', async () => {
    const { apply, snapshots } = makeSetup();
    snapshots.build.mockResolvedValue(snapshotOf('54x40'));

    const columns = await apply(setupOf({ sceneId: NEW_SCENE, pageCount: 4 }), documentRow());

    expect(columns).toMatchObject({ format: '54x40', pageCount: 4 });
  });

  it('três páginas no 54x40: 422 FLYER_PRO_PAGE_COUNT_INVALID com as opções do formato', async () => {
    const { apply } = makeSetup();

    await expect(
      refusalOf(apply(setupOf({ pageCount: 3 }), documentRow({ format: '54x40', pageCount: 2 }))),
    ).resolves.toEqual({
      status: 422,
      code: 'FLYER_PRO_PAGE_COUNT_INVALID',
      details: { format: '54x40', allowed: [2, 4] },
    });
  });

  it('a conferência é contra o formato resultante: 1 página não serve ao 54x40 que a cena nova traz', async () => {
    const { apply, snapshots } = makeSetup();
    snapshots.build.mockResolvedValue(snapshotOf('54x40'));

    await expect(
      refusalOf(apply(setupOf({ sceneId: NEW_SCENE, pageCount: 1 }), documentRow())),
    ).resolves.toMatchObject({
      code: 'FLYER_PRO_PAGE_COUNT_INVALID',
      details: { format: '54x40' },
    });
  });

  it('quatro páginas no 27x40 é aceito; no mesmo formato sem pageCount nada muda', async () => {
    const { apply } = makeSetup();

    await expect(apply(setupOf({ pageCount: 4 }))).resolves.toEqual({ pageCount: 4 });
    await expect(apply(setupOf({ name: 'x' }))).resolves.toEqual({ name: 'x' });
  });
});
