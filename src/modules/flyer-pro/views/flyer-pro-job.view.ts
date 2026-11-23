import type {
  EnrichError,
  EnrichModels,
  EnrichPhase,
  EnrichResult,
  EnrichStep,
  JobStatus,
} from '../domain/flyer-pro-job.types';
import { isStalled } from '../domain/flyer-pro-enrich-rules';
import type { FlyerProJob } from '../entities/flyer-pro-job.entity';

/**
 * O job como as rotas o devolvem (N3, N4, N14, N15 e N16): 22 campos, nunca `cursor`, `batchSeq`, `batchAttempts`,
 * `cancelRequestedAt` nem `updatedAt` (internos da máquina do job). Datas em ISO 8601 UTC; `itemsUpdatedAt` já vem
 * como texto com microssegundos.
 */
export interface FlyerProJobView {
  id: string;
  documentId: string;
  status: JobStatus;
  steps: EnrichStep[];
  phase: EnrichPhase | null;
  total: number;
  processed: number;
  itemIds: string[] | null;
  onlyMissing: boolean;
  autoApply: boolean;
  result: EnrichResult;
  error: EnrichError | null;
  models: EnrichModels | null;
  costUsd: number | null;
  cancelRequested: boolean;
  stalled: boolean;
  itemsUpdatedAt: string;
  createdByUserId: string | null;
  createdAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
}

const iso = (date: Date | string): string => new Date(date).toISOString();
const isoOrNull = (date: Date | string | null | undefined): string | null =>
  date ? iso(date) : null;

export function toJobView(job: FlyerProJob, itemsUpdatedAt: string, now: Date): FlyerProJobView {
  return {
    id: job.id,
    documentId: job.documentId,
    status: job.status,
    steps: job.steps,
    phase: job.phase ?? null,
    total: job.total,
    processed: job.processed,
    itemIds: job.itemIds ?? null,
    onlyMissing: job.onlyMissing,
    autoApply: job.autoApply,
    result: job.result ?? {},
    error: job.error ?? null,
    models: job.models ?? null,
    costUsd: job.costUsd ?? null,
    cancelRequested: job.cancelRequestedAt != null,
    stalled: isStalled(
      {
        status: job.status,
        updatedAt: new Date(job.updatedAt),
        heartbeatAt: job.heartbeatAt ? new Date(job.heartbeatAt) : null,
      },
      now,
    ),
    itemsUpdatedAt,
    createdByUserId: job.createdByUserId ?? null,
    createdAt: iso(job.createdAt),
    startedAt: isoOrNull(job.startedAt),
    heartbeatAt: isoOrNull(job.heartbeatAt),
    finishedAt: isoOrNull(job.finishedAt),
  };
}
