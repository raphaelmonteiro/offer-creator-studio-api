import type { EntityManager } from 'typeorm';
import { canRetryEan, eanRetryDelaySeconds } from '../domain/flyer-pro-enrich-image';
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
  /** Espera antes de o próximo lote ser assumido: só a passada do EAN pendente espera (30, 60 e 120 s). */
  delaySeconds: number;
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
 * A próxima passada do EAN pendente, se cabe: o job pediu `image_match` (e ela não foi pulada), ainda há item
 * `ean_pending` no escopo e o job ainda não usou as 3 passadas. A passada nova guarda o número dela no cursor e espera
 * 30, 60 ou 120 s; o `pass` segue entre as rodadas da conferência final (no máximo 3 por job).
 */
async function nextEanRetry(
  manager: EntityManager,
  job: FlyerProJob,
  phases: EnrichStep[],
): Promise<NextState | null> {
  const cursor = job.cursor ?? FRESH_CURSOR;
  if (!phases.includes('image_match') || !canRetryEan(cursor.pass)) return null;
  const waiting = await countEligible(manager, {
    documentId: job.documentId,
    scope: job.itemIds,
    phase: 'image_ean_retry',
    onlyMissing: true,
  });
  if (waiting === 0) return null;
  const pass = cursor.pass + 1;
  return {
    phase: 'image_ean_retry',
    cursor: { ...reset(cursor), pass },
    total: job.total,
    done: false,
    delaySeconds: eanRetryDelaySeconds(pass),
  };
}

/**
 * O que vem depois de fechar a fase: a próxima fase pedida e não pulada; depois da última (ou de uma passada do EAN), a
 * passada seguinte do EAN pendente, se cabe; senão a conferência final (até 3 rodadas, somando ao `total` os itens que
 * ainda se encaixam) ou o fim do job. As passadas ficam fora de `total` e de `processed` (D-2 (a)).
 */
export async function nextState(
  manager: EntityManager,
  job: FlyerProJob,
  phase: EnrichPhase,
  result: FlyerProJob['result'],
): Promise<NextState> {
  const cursor = job.cursor ?? FRESH_CURSOR;
  const phases = runnablePhases(job.steps, result);
  const next = phase === 'image_ean_retry' ? null : nextPhase(phases, phase);
  if (next) {
    return { phase: next, cursor: reset(cursor), total: job.total, done: false, delaySeconds: 0 };
  }
  const retry = await nextEanRetry(manager, job, phases);
  if (retry) return retry;
  const pending = await pendingCount(manager, job, phases);
  if (needsAnotherRound(cursor.round, pending)) {
    const again = { ...reset(cursor), round: cursor.round + 1 };
    const total = job.total + pending;
    return { phase: phases[0], cursor: again, total, done: false, delaySeconds: 0 };
  }
  return { phase: null, cursor: reset(cursor), total: job.total, done: true, delaySeconds: 0 };
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
