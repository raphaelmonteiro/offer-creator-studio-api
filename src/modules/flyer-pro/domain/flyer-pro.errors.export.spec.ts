import { HttpException } from '@nestjs/common';
import { flyerProExportIdConflict, flyerProExportInvalid } from './flyer-pro.errors';

/** O envelope que o `HttpExceptionFilter` monta com o `getResponse()` de cada fábrica. */
const bodyOf = (error: HttpException) => ({
  status: error.getStatus(),
  ...(error.getResponse() as object),
});

describe('fábricas de erro das exportações', () => {
  it('FLYER_PRO_EXPORT_INVALID: 422 com a lista em `issues`, fora de `details`', () => {
    const issues = [
      { field: 'options.sheets', code: 'PRESET_MISMATCH' },
      { field: 'fileName', code: 'FILE_NAME_EXTENSION' },
    ];

    const body = bodyOf(flyerProExportInvalid(issues));

    expect(body).toEqual({
      status: 422,
      code: 'FLYER_PRO_EXPORT_INVALID',
      message: 'O registro da exportação está incoerente.',
      issues,
    });
    expect(body).not.toHaveProperty('details');
  });

  it('FLYER_PRO_EXPORT_ID_CONFLICT: 409 com o id da exportação em `details`', () => {
    expect(bodyOf(flyerProExportIdConflict('5b0e2c1a-8d3f-4a4e-9c11-2f6a7d9e0b13'))).toEqual({
      status: 409,
      code: 'FLYER_PRO_EXPORT_ID_CONFLICT',
      message: 'A exportação pertence a outro encarte.',
      details: { exportId: '5b0e2c1a-8d3f-4a4e-9c11-2f6a7d9e0b13' },
    });
  });
});
