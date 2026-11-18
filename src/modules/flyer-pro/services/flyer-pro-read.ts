import type { DataSource, EntityManager } from 'typeorm';
import { flyerProNotFound } from '../domain/flyer-pro.errors';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';

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

/** Confere que o encarte existe e está vivo (excluído conta como inexistente): 404 `FLYER_PRO_NOT_FOUND`. Só lê. */
export async function assertLiveDocument(manager: EntityManager, id: string): Promise<void> {
  const document = await manager.findOne(FlyerProDocument, { where: { id }, select: { id: true } });
  if (!document) throw flyerProNotFound();
}
