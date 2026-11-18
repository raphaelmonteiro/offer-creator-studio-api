import { QueryFailedError } from 'typeorm';
import { pgErrorOf } from './pg-error';

const queryFailed = (driverError: unknown) =>
  new QueryFailedError('INSERT ...', [], driverError as Error);

describe('pgErrorOf', () => {
  it('erro do Postgres: devolve o código e a restrição do driver', () => {
    const driver = { code: '23505', constraint: 'UQ_flyer_pro_jobs_document_active' };

    expect(pgErrorOf(queryFailed(driver))).toEqual(driver);
  });

  it('QueryFailedError sem restrição: devolve só o código', () => {
    expect(pgErrorOf(queryFailed({ code: '23503' }))).toEqual({ code: '23503' });
  });

  it('outro erro, ainda que com a mesma forma: undefined', () => {
    const lookalike = Object.assign(new Error('falhou'), { code: '23505', constraint: 'X' });

    expect(pgErrorOf(lookalike)).toBeUndefined();
    expect(pgErrorOf(new Error('rede'))).toBeUndefined();
  });

  it('undefined, null e texto: undefined', () => {
    expect(pgErrorOf(undefined)).toBeUndefined();
    expect(pgErrorOf(null)).toBeUndefined();
    expect(pgErrorOf('23505')).toBeUndefined();
  });
});
