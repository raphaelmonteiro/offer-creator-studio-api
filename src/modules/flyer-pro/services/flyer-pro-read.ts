import type { DataSource, EntityManager } from 'typeorm';

/**
 * Roda a leitura no `manager` de quem chama (a transação dele, A-10) ou, sem ele, numa transação `REPEATABLE READ`
 * própria: as consultas de uma chamada enxergam o mesmo instante do banco, mesmo com a cena sendo reprojetada. Nada é
 * gravado aqui.
 */
export function readWith<T>(
  dataSource: DataSource,
  manager: EntityManager | undefined,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return manager ? work(manager) : dataSource.transaction('REPEATABLE READ', work);
}
