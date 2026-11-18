import { HttpException } from '@nestjs/common';
import {
  flyerProAppOutdated,
  flyerProBadRequest,
  flyerProFoldLocked,
  flyerProItemIdConflict,
  flyerProItemInvalid,
  flyerProItemLimit,
  flyerProPageCountInvalid,
  flyerProRevisionConflict,
  flyerProSliceTooLarge,
  flyerProUiTooLarge,
} from './flyer-pro.errors';

/** O envelope que o `HttpExceptionFilter` monta com o `getResponse()` de cada fábrica do salvar. */
const bodyOf = (error: HttpException) => ({
  status: error.getStatus(),
  ...(error.getResponse() as object),
});

describe('fábricas de erro do salvar', () => {
  it('REVISION_CONFLICT: 409 com a revisão, a hora e o autor da gravação atual', () => {
    const details = { revision: 38, updatedAt: '2026-11-14T14:33:10.000Z', updatedByUserId: 'u1' };
    expect(bodyOf(flyerProRevisionConflict(details))).toEqual({
      status: 409,
      code: 'REVISION_CONFLICT',
      message: 'O encarte mudou em outra aba ou por outra pessoa. Recarregue para continuar.',
      details,
    });
  });

  it('FLYER_PRO_APP_OUTDATED: 409 com as versões gravadas', () => {
    expect(bodyOf(flyerProAppOutdated({ schemaVersion: 1, engineVersion: 2 }))).toEqual({
      status: 409,
      code: 'FLYER_PRO_APP_OUTDATED',
      message: 'Há uma versão nova do app. Recarregue a página para continuar.',
      details: { schemaVersion: 1, engineVersion: 2 },
    });
  });

  it('FLYER_PRO_SLICE_TOO_LARGE e FLYER_PRO_UI_TOO_LARGE: 422 com os bytes e o teto', () => {
    expect(
      bodyOf(flyerProSliceTooLarge({ slice: 'assembly', bytes: 300_000, max: 262_144 })),
    ).toEqual({
      status: 422,
      code: 'FLYER_PRO_SLICE_TOO_LARGE',
      message: 'Parte do encarte grande demais para salvar.',
      details: { slice: 'assembly', bytes: 300_000, max: 262_144 },
    });
    expect(bodyOf(flyerProUiTooLarge({ bytes: 20_000, max: 16_384 }))).toEqual({
      status: 422,
      code: 'FLYER_PRO_UI_TOO_LARGE',
      message: 'Estado de tela grande demais para salvar.',
      details: { bytes: 20_000, max: 16_384 },
    });
  });

  it('FLYER_PRO_FOLD_LOCKED e FLYER_PRO_PAGE_COUNT_INVALID: 422 com o formato', () => {
    expect(bodyOf(flyerProFoldLocked({ format: '27x40', newFormat: '54x40' }))).toEqual({
      status: 422,
      code: 'FLYER_PRO_FOLD_LOCKED',
      message:
        'As páginas já foram montadas: não é possível trocar para um template de outro formato.',
      details: { format: '27x40', newFormat: '54x40' },
    });
    expect(bodyOf(flyerProPageCountInvalid({ format: '54x40', allowed: [2, 4] }))).toEqual({
      status: 422,
      code: 'FLYER_PRO_PAGE_COUNT_INVALID',
      message: 'Número de páginas inválido para o formato.',
      details: { format: '54x40', allowed: [2, 4] },
    });
  });

  it('FLYER_PRO_ITEM_INVALID: 422 com a lista em `issues`, fora de `details`', () => {
    const issues = [{ itemId: 'i1', field: 'unit', code: 'UNIT_UNKNOWN' }];
    const body = bodyOf(flyerProItemInvalid(issues));
    expect(body).toEqual({
      status: 422,
      code: 'FLYER_PRO_ITEM_INVALID',
      message: 'Há itens com dados inválidos.',
      issues,
    });
    expect(body).not.toHaveProperty('details');
  });

  it('FLYER_PRO_ITEM_LIMIT e FLYER_PRO_ITEM_ID_CONFLICT: o total e os ids em `details`', () => {
    expect(bodyOf(flyerProItemLimit({ max: 500, total: 501 }))).toEqual({
      status: 422,
      code: 'FLYER_PRO_ITEM_LIMIT',
      message: 'O encarte passaria de 500 itens.',
      details: { max: 500, total: 501 },
    });
    expect(bodyOf(flyerProItemIdConflict(['i9']))).toEqual({
      status: 409,
      code: 'FLYER_PRO_ITEM_ID_CONFLICT',
      message: 'Há itens que pertencem a outro encarte.',
      details: { itemIds: ['i9'] },
    });
  });

  it('BAD_REQUEST: 400 com o texto dado', () => {
    expect(bodyOf(flyerProBadRequest('ids repetidos'))).toEqual({
      status: 400,
      code: 'BAD_REQUEST',
      message: 'ids repetidos',
    });
  });
});
