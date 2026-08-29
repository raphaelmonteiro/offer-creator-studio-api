import { QUEUES, QueueName } from '../../../shared/queue/animation-queue.service';
import { McStepStatus } from './mc-state-machines';
import { mcExpireForQueue, mcQueueForStep } from './mc-pipeline.config';
import { McStepType } from './mc-types';

/**
 * Watchdog de steps órfãos (correção do gap demonstrado em dev): um step fica
 * "órfão" quando seu estado aponta trabalho em andamento mas não existe mais
 * nenhum job vivo no pg-boss para ele — ex.: o job estourou o retryLimit em
 * ciclos silenciosos de expire (guard recusando admissão) ou o worker morreu
 * entre o CAS e o publish. Sem isso, o step trava para sempre e a cena fica
 * `running` — inclusive bloqueando re-roll ("trabalho em andamento").
 *
 * Este módulo é a parte PURA: dado um step órfão, decide o job de reposição.
 */
export interface McOrphanStep {
  id: string;
  projectId: string;
  type: McStepType;
  status: McStepStatus;
  provider: string | null;
  providerJobId: string | null;
}

export interface McWatchdogTarget {
  queue: QueueName;
  payload: Record<string, unknown>;
  options: { expireInSeconds: number; singletonKey?: string };
}

/** Idade mínima (ms) para considerar um step órfão — evita corrida com publishes em voo. */
export const MC_WATCHDOG_MIN_AGE_MS = 120_000;

/** Reconstrução determinística da URL de resultado da fila fal (mesma regra do poll). */
export function mcDefaultResponseUrl(step: McOrphanStep): string {
  return `https://queue.fal.run/${step.provider}/requests/${step.providerJobId}`;
}

/**
 * Job de reposição para um step órfão, por estado:
 * - queued        → refila na fila do próprio tipo (handler é CAS-idempotente);
 * - provider_wait → volta pelo poll (attempt 0; timeout duro de 15 min recomeça —
 *                   aceitável: o provider já concluiu ou concluirá);
 * - ingesting     → refila o ingest com a responseUrl reconstruída.
 * Estados terminais/pending/running não são repostos (pending é papel do
 * scheduler; running local sem job é indistinguível de handler vivo).
 */
export function mcWatchdogTarget(step: McOrphanStep, nowMs: number): McWatchdogTarget | null {
  switch (step.status) {
    case McStepStatus.QUEUED: {
      const queue = mcQueueForStep(step.type);
      return {
        queue,
        payload: { stepId: step.id, projectId: step.projectId },
        options: { expireInSeconds: mcExpireForQueue(queue) },
      };
    }
    case McStepStatus.PROVIDER_WAIT:
      return {
        queue: QUEUES.MC_POLL,
        payload: { stepId: step.id, attempt: 0 },
        options: {
          expireInSeconds: mcExpireForQueue(QUEUES.MC_POLL),
          // chave única por reposição: não pode colidir com a cadeia antiga
          singletonKey: `poll:${step.id}:w${nowMs}`,
        },
      };
    case McStepStatus.INGESTING:
      return {
        queue: QUEUES.MC_INGEST,
        payload: { stepId: step.id, responseUrl: mcDefaultResponseUrl(step) },
        options: { expireInSeconds: mcExpireForQueue(QUEUES.MC_INGEST) },
      };
    default:
      return null;
  }
}
