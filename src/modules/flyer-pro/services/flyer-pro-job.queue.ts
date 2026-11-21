import type { EntityManager } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import type { BatchMessage } from '../processors/flyer-pro-enrich.types';

/**
 * Publica um lote do job na fila (`flyer_pro.enrich`) na transação do `manager`: sempre `retryLimit: 0` (a repetição é do
 * job, com ficha e espera) e `expireInSeconds` igual a `FLYER_PRO_ENRICH_BATCH_EXPIRE_SECONDS`. A espera só vai às opções
 * quando é maior que zero. O ponto único das opções do lote: quem publica (criação, lote seguinte, repetição, parada e
 * reconciliador) chama esta função, cada um no savepoint em que já está.
 */
export function publishJobBatch(
  queue: AnimationQueueService,
  manager: EntityManager,
  message: BatchMessage,
  options: { expireInSeconds: number; startAfterSeconds?: number },
): Promise<unknown> {
  const { expireInSeconds, startAfterSeconds } = options;
  return queue.publish(QUEUES.FLYER_PRO_ENRICH, message, {
    manager,
    retryLimit: 0,
    expireInSeconds,
    ...(startAfterSeconds > 0 ? { startAfterSeconds } : {}),
  });
}
