import { addCost, JobCost } from '../domain/flyer-pro-enrich-cost';
import { retryCounts, withImageExtras } from '../domain/flyer-pro-enrich-image';
import {
  addCounts,
  addTiming,
  markSkipped,
  PhaseCounts,
  withModel,
} from '../domain/flyer-pro-enrich-rules';
import type { EnrichResult, EnrichStep } from '../domain/flyer-pro-job.types';
import type { FlyerProJob } from '../entities/flyer-pro-job.entity';
import type { JobColumns } from './flyer-pro-enrich.statements';
import type { UnitPlan } from './flyer-pro-enrich.types';

/** As colunas que um lote soma ao job (com `result` e `processed` sempre presentes). */
export interface ProgressColumns extends JobColumns {
  result: EnrichResult;
  processed: number;
}

/** O que um lote soma ao job, e o custo para o chamador marcar o cursor se ele ficou desconhecido. */
export interface Progress {
  columns: ProgressColumns;
  cost: JobCost;
}

/**
 * As contagens do lote em `result`: a fase soma o que o `UPDATE` afetou e os itens lidos (`visited`); a passada do EAN
 * soma só a troca de contagem (o item que sai de `eanPending`), sem `visited` (A-14, D-2 (a)). Na fase de fotos entram
 * também `nameSearchUnavailable` e `eanBudgetBlocked`.
 */
function withCounts(result: EnrichResult, plan: UnitPlan, counts: PhaseCounts): EnrichResult {
  const retry = plan.phase === 'image_ean_retry';
  const visited = plan.work?.items.length ?? 0;
  const summed = retry
    ? addCounts(result, 'image_match', retryCounts(counts))
    : addCounts(result, plan.phase as EnrichStep, { visited, ...counts });
  if (plan.work?.phase !== 'image_match') return summed;
  return withImageExtras(summed, {
    nameSearchUnavailable: plan.work.nameSearchUnavailable === true,
    eanBudgetBlocked: counts.eanBudgetBlocked ?? 0,
  });
}

/**
 * O que o lote soma ao job: contagens, pulo, timing, `processed`, modelo e custo; zera as tentativas e o batimento. A
 * passada do EAN não soma em `processed` (as passadas ficam fora de `total` e `processed`, D-2 (a)). O modelo é o do uso
 * da chamada (o da feature, mesmo sem chamada paga); fase pulada não traz modelo.
 */
export function progressOf(
  current: FlyerProJob,
  plan: UnitPlan,
  counts: PhaseCounts | null,
): Progress {
  const visited = plan.work?.items.length ?? 0;
  let result = counts ? withCounts(current.result, plan, counts) : current.result;
  if (plan.skipped) result = markSkipped(result, plan.phase as EnrichStep);
  result = addTiming(result, plan.phase, { items: visited, durationMs: plan.totalMs });
  const cost = addCost(current, plan.usage);
  const counted = plan.phase === 'image_ean_retry' ? 0 : plan.skipped ? plan.skippedItems : visited;
  const models = plan.usage?.model
    ? withModel(current.models, plan.phase, plan.usage.model)
    : current.models;
  return {
    cost,
    columns: {
      processed: current.processed + counted,
      result,
      models,
      costUsd: cost.costUsd,
      batchAttempts: 0,
      clearHeartbeat: true,
    },
  };
}
