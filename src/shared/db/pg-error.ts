import { QueryFailedError } from 'typeorm';

/** O que o driver do Postgres traz num erro de consulta: o código (`23505`, `23503`...) e o nome da restrição. */
export interface PgErrorInfo {
  code?: string;
  constraint?: string;
}

/**
 * O erro do driver do Postgres, só quando `error` é um `QueryFailedError`; qualquer outro valor (erro de rede, `undefined`,
 * texto) devolve `undefined`. Um lugar só para os predicados "violação de unicidade/chave estrangeira de tal restrição".
 */
export function pgErrorOf(error: unknown): PgErrorInfo | undefined {
  if (!(error instanceof QueryFailedError)) return undefined;
  return error.driverError as PgErrorInfo | undefined;
}
