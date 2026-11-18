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

/**
 * A regra única de "encarte vivo" (excluído conta como inexistente): 404 `FLYER_PRO_NOT_FOUND`. Só lê as colunas pedidas;
 * a leitura do ORM já ignora a linha com `deletedAt`.
 */
async function findLiveDocument(
  manager: EntityManager,
  id: string,
  select: { id: true; revision?: true },
): Promise<FlyerProDocument> {
  const document = await manager.findOne(FlyerProDocument, { where: { id }, select });
  if (!document) throw flyerProNotFound();
  return document;
}

/** Confere que o encarte existe e está vivo: 404 `FLYER_PRO_NOT_FOUND`. Só lê. */
export async function assertLiveDocument(manager: EntityManager, id: string): Promise<void> {
  await findLiveDocument(manager, id, { id: true });
}

/** Como `assertLiveDocument`, e devolve a revisão atual do encarte (o N8 compara `documentRevision` com ela). Só lê. */
export async function readLiveRevision(manager: EntityManager, id: string): Promise<number> {
  return (await findLiveDocument(manager, id, { id: true, revision: true })).revision;
}
