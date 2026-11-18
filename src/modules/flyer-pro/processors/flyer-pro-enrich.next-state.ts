import type { EntityManager } from 'typeorm';
import {
  enrichError,
  finalFields,
  needsAnotherRound,
  nextPhase,
  runnablePhases,
} from '../domain/flyer-pro-enrich-rules';
import type {
  EnrichCursor,
  EnrichErrorCode,
  EnrichPhase,
  EnrichStep,
} from '../domain/flyer-pro-job.types';
import type { FlyerProJob } from '../entities/flyer-pro-job.entity';
import { countEligible } from '../services/flyer-pro-job.scope';
import type { JobColumns } from './flyer-pro-enrich.statements';

/** O cursor de um job que ainda não gravou nenhum lote: a primeira rodada, sem ponto na fase. */
export const FRESH_CURSOR: EnrichCursor = { round: 1, pass: 0, position: null, id: null };

/** O que o job guarda depois de fechar uma fase: a próxima fase (ou nenhuma), o cursor, o `total` e se o job acabou. */
export interface NextState {
  phase: EnrichPhase | null;
  cursor: EnrichCursor;
  total: number;
  done: boolean;
}

const reset = (cursor: EnrichCursor): EnrichCursor => ({ ...cursor, position: null, id: null });

/** Itens do escopo que ainda se encaixam em alguma fase pedida e não pulada, pelo critério de `onlyMissing` ligado. */
async function pendingCount(
  manager: EntityManager,
  job: FlyerProJob,
  phases: EnrichStep[],
): Promise<number> {
  let pending = 0;
  for (const phase of phases) {
    pending += await countEligible(manager, {
      documentId: job.documentId,
      scope: job.itemIds,
      phase,
      onlyMissing: true,
    });
  }
  return pending;
}

/**
 * O que vem depois de fechar a fase: a próxima fase pedida e não pulada, ou, depois da última, a conferência final (até
 * 3 rodadas, somando ao `total` os itens que ainda se encaixam) ou o fim do job.
 */
export async function nextState(
  manager: EntityManager,
  job: FlyerProJob,
  phase: EnrichStep,
  result: FlyerProJob['result'],
): Promise<NextState> {
  const cursor = job.cursor ?? FRESH_CURSOR;
  const phases = runnablePhases(job.steps, result);
  const next = nextPhase(phases, phase);
  if (next) return { phase: next, cursor: reset(cursor), total: job.total, done: false };
  const pending = await pendingCount(manager, job, phases);
  if (needsAnotherRound(cursor.round, pending)) {
    const again = { round: cursor.round + 1, pass: 0, position: null, id: null };
    return { phase: phases[0], cursor: again, total: job.total + pending, done: false };
  }
  return { phase: null, cursor: reset(cursor), total: job.total, done: true };
}

/** `done`: a fase zera e o job fecha. */
export const doneColumns = (cursor: EnrichCursor): JobColumns => ({
  ...finalFields('done', null),
  cursor,
  finish: true,
});

/** `failed` com o `error` do código; a fase em que o job parou fica gravada. */
export function failedColumns(
  code: EnrichErrorCode,
  phase: EnrichPhase | null,
  attempts: number,
): JobColumns {
  return {
    ...finalFields('failed', phase),
    error: enrichError(code, phase),
    ...(attempts > 0 ? { batchAttempts: attempts } : {}),
    clearHeartbeat: true,
    finish: true,
  };
}
