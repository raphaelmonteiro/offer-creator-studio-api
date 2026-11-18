import type { EntityManager } from 'typeorm';

/** O resultado de um passo que pode falhar sem derrubar a transação que o contém. */
export type SavepointOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Roda `work` dentro de um savepoint da transação do `manager`: se falhar, só o que ele fez é desfeito (a transação
 * continua utilizável) e o erro volta no resultado, sem ser lançado. É como o N4 cria o job e o N16 publica o lote
 * imediato sem que a falha mude o resto da gravação.
 */
export async function inSavepoint<T>(
  manager: EntityManager,
  name: string,
  work: () => Promise<T>,
): Promise<SavepointOutcome<T>> {
  await manager.query(`SAVEPOINT ${name}`);
  try {
    const value = await work();
    await manager.query(`RELEASE SAVEPOINT ${name}`);
    return { ok: true, value };
  } catch (error) {
    await manager.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return { ok: false, error };
  }
}
