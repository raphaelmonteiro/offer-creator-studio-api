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
