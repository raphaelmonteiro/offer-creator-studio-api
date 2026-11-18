import { HttpException } from '@nestjs/common';
import {
  flyerProImportIdConflict,
  flyerProImportInvalid,
  flyerProItemInvalid,
} from './flyer-pro.errors';

/** O envelope que o `HttpExceptionFilter` monta com o `getResponse()` de cada fábrica. */
const bodyOf = (error: HttpException) => ({
  status: error.getStatus(),
  ...(error.getResponse() as object),
});

describe('fábricas de erro das importações', () => {
  it('FLYER_PRO_IMPORT_INVALID: 422 com a lista em `issues`, fora de `details`', () => {
    const issues = [{ field: 'acceptedCount', code: 'COUNT_MISMATCH' }];
    const body = bodyOf(flyerProImportInvalid(issues));
    expect(body).toEqual({
      status: 422,
      code: 'FLYER_PRO_IMPORT_INVALID',
      message: 'O registro da importação está incoerente.',
      issues,
    });
    expect(body).not.toHaveProperty('details');
  });

  it('FLYER_PRO_IMPORT_ID_CONFLICT: 409 com o id da importação em `details`', () => {
    expect(bodyOf(flyerProImportIdConflict('imp-1'))).toEqual({
      status: 409,
      code: 'FLYER_PRO_IMPORT_ID_CONFLICT',
      message: 'A importação pertence a outro encarte.',
      details: { importId: 'imp-1' },
    });
  });

  it('o envelope dos itens continua o mesmo, vindo do mesmo ajudante', () => {
    const issues = [{ itemId: 'i1', field: 'importId', code: 'IMPORT_UNKNOWN' }];
    expect(bodyOf(flyerProItemInvalid(issues))).toEqual({
      status: 422,
      code: 'FLYER_PRO_ITEM_INVALID',
      message: 'Há itens com dados inválidos.',
      issues,
    });
  });
});
