import { randomUUID } from 'crypto';
import { EntityManager, In } from 'typeorm';
import type { EnrichStep } from '../domain/flyer-pro-job.types';
import { FlyerProJob } from '../entities/flyer-pro-job.entity';

/** Os comandos sobre `flyer_pro_jobs` que as rotas e o N4 compartilham: ler o job do encarte e inserir um novo. */

const ACTIVE = ['queued', 'running'] as const;

/** O job ativo (`queued` ou `running`) do encarte, ou `null`. O índice único garante no máximo um. */
export function findActiveJob(
  manager: EntityManager,
  documentId: string,
): Promise<FlyerProJob | null> {
  return manager.findOne(FlyerProJob, { where: { documentId, status: In([...ACTIVE]) } });
}

/** O job mais recente do encarte por `createdAt`, qualquer que seja o estado, ou `null`. */
export function findLatestJob(
  manager: EntityManager,
  documentId: string,
): Promise<FlyerProJob | null> {
  return manager.findOne(FlyerProJob, {
    where: { documentId },
    order: { createdAt: 'DESC', id: 'DESC' },
  });
}

/** O job que o encarte mostra: o ativo e, sem ativo, o mais recente; `null` se o encarte nunca teve job. */
export async function findCurrentJob(
  manager: EntityManager,
  documentId: string,
): Promise<FlyerProJob | null> {
  return (await findActiveJob(manager, documentId)) ?? (await findLatestJob(manager, documentId));
}

export interface NewJob {
  documentId: string;
  userId: string;
  steps: EnrichStep[];
  itemIds: string[] | null;
  onlyMissing: boolean;
  autoApply: boolean;
  total: number;
}

/** Insere o job `queued` e o devolve lido; a violação do índice de job ativo (`23505`) sobe para quem chamou. */
export async function insertJob(manager: EntityManager, job: NewJob): Promise<FlyerProJob> {
  const id = randomUUID();
  await manager.insert(FlyerProJob, {
    id,
    documentId: job.documentId,
    steps: job.steps,
    itemIds: job.itemIds,
    onlyMissing: job.onlyMissing,
    autoApply: job.autoApply,
    total: job.total,
    createdByUserId: job.userId,
  });
  return manager.findOneByOrFail(FlyerProJob, { id });
}

/** O job ativo do encarte com a linha travada até o fim da transação (o N16 trava só o job, A-23), ou `null`. */
export function lockActiveJob(
  manager: EntityManager,
  documentId: string,
): Promise<FlyerProJob | null> {
  return manager.findOne(FlyerProJob, {
    where: { documentId, status: In([...ACTIVE]) },
    lock: { mode: 'pessimistic_write' },
  });
}

/** Job `queued` vira `canceled` na hora (nenhum lote começou), com o pedido gravado e `finishedAt`; devolve o job lido. */
export async function cancelQueuedJob(manager: EntityManager, id: string): Promise<FlyerProJob> {
  await manager.query(
    `UPDATE "flyer_pro_jobs"
        SET "status" = 'canceled', "cancelRequestedAt" = COALESCE("cancelRequestedAt", now()),
            "finishedAt" = now(), "updatedAt" = now()
      WHERE "id" = $1`,
    [id],
  );
  return manager.findOneByOrFail(FlyerProJob, { id });
}

/** Grava o primeiro pedido de parada (o seguinte não o muda); devolve o job lido. O estado só muda no fim do lote. */
export async function requestJobStop(manager: EntityManager, id: string): Promise<FlyerProJob> {
  await manager.query(
    `UPDATE "flyer_pro_jobs"
        SET "cancelRequestedAt" = COALESCE("cancelRequestedAt", now()), "updatedAt" = now()
      WHERE "id" = $1`,
    [id],
  );
  return manager.findOneByOrFail(FlyerProJob, { id });
}

/**
 * Grava o primeiro pedido de parada no job ativo do encarte, se houver (a exclusão do encarte, N6): o job fecha
 * `canceled` no próximo lote que tentar assumir ou na varredura, sem chamar o provedor de novo.
 */
export async function requestStopOfActiveJob(
  manager: EntityManager,
  documentId: string,
): Promise<void> {
  await manager.query(
    `UPDATE "flyer_pro_jobs"
        SET "cancelRequestedAt" = COALESCE("cancelRequestedAt", now()), "updatedAt" = now()
      WHERE "documentId" = $1 AND "status" IN ('queued', 'running')`,
    [documentId],
  );
}
