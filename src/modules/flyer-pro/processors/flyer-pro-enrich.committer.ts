import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import type { AiInvocationUsage } from '../../ai/utils/ai-usage';
import { FLYER_PRO_ENRICH_CONFIG, FlyerProEnrichConfig } from '../config/flyer-pro-enrich.config';
import { addCost, withCostMark } from '../domain/flyer-pro-enrich-cost';
import {
  effectiveOnlyMissing,
  failureDecision,
  finalFields,
  retryDelaySeconds,
} from '../domain/flyer-pro-enrich-rules';
import type {
  EnrichCursor,
  EnrichErrorCode,
  EnrichPhase,
  EnrichResult,
} from '../domain/flyer-pro-job.types';
import type { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import type { FlyerProJob } from '../entities/flyer-pro-job.entity';
import { publishJobBatch } from '../services/flyer-pro-job.queue';
import { inSavepoint } from '../services/flyer-pro-savepoint';
import { findLockedDocument, readStamp } from '../services/flyer-pro-save.statements';
import { progressOf } from './flyer-pro-enrich.progress';
import type { JobColumns } from './flyer-pro-enrich.statements';
import { lockJob, updateJob } from './flyer-pro-enrich.statements';
import type { UnitPlan } from './flyer-pro-enrich.types';
import {
  doneColumns,
  failedColumns,
  FRESH_CURSOR,
  NextState,
  nextState,
} from './flyer-pro-enrich.next-state';
import type { WriteContext } from './flyer-pro-enrich.item-write';
import { applyWrites, planWrites } from './flyer-pro-enrich.writes';

/** O resultado de uma gravação: feita, ou descartada porque a ficha não bate (lote zumbi) ou o job sumiu. */
export type CommitOutcome = 'committed' | 'discarded';

/** A falha do provedor classificada: o código do job e se ela é terminal (sem repetição). */
export interface BatchFailure {
  code: Extract<EnrichErrorCode, 'AI_PROVIDER_ERROR' | 'AI_TIMEOUT'>;
  terminal: boolean;
}

/** O que a transação travou: o encarte, a linha do job relida e se há motivo para parar (excluído ou parada pedida). */
interface Locked {
  manager: EntityManager;
  document: FlyerProDocument;
  current: FlyerProJob;
  stopping: boolean;
}

/** O custo das chamadas pagas de uma falha de lote: `costUsd` e, se ele ficou desconhecido, a marca no cursor. */
function paidColumns(current: FlyerProJob, usage: AiInvocationUsage | null): JobColumns {
  const cost = addCost(current, usage);
  const marked = cost.unknown && !current.cursor?.costUnknown;
  return {
    costUsd: cost.costUsd,
    ...(marked ? { cursor: withCostMark(current.cursor ?? FRESH_CURSOR, true) } : {}),
  };
}

/** O estado depois do lote: o mesmo lote na mesma fase se ainda há itens, senão o fechamento da fase (`nextState`). */
function nextOf(
  { manager, current }: Locked,
  plan: UnitPlan,
  after: { result: EnrichResult; moved: EnrichCursor },
): Promise<NextState> {
  const closes = plan.skipped || (plan.work?.items.length ?? 0) < plan.batchSize;
  if (closes) return nextState(manager, current, plan.phase, after.result);
  return Promise.resolve({
    phase: plan.phase as EnrichPhase | null,
    cursor: after.moved,
    total: current.total,
    done: false,
  });
}

/**
 * As gravações do processador, cada uma numa transação curta: travam o encarte e depois a linha do job (A-23), conferem a
 * ficha (`status = running` e `batchSeq` igual ao do lote) e só então gravam; ficha que não bate descarta o resultado
 * sem tocar em nenhum item. O próximo lote é publicado na mesma transação, num savepoint.
 */
@Injectable()
export class FlyerProEnrichCommitter {
  private readonly logger = new Logger(FlyerProEnrichCommitter.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: AnimationQueueService,
    @Inject(FLYER_PRO_ENRICH_CONFIG) private readonly config: FlyerProEnrichConfig,
  ) {}

  /** Grava o lote (ou o fechamento ou pulo da fase) e decide o que vem depois: outro lote, outra fase, outra rodada ou o fim. */
  commitUnit(job: FlyerProJob, plan: UnitPlan): Promise<CommitOutcome> {
    return this.locked(job, async (locked) => {
      const { manager, current } = locked;
      const cursor = current.cursor ?? FRESH_CURSOR;
      const ctx = await this.writeContext(locked, cursor.round);
      const counts = plan.work ? await applyWrites(manager, planWrites(plan.work, ctx)) : null;
      const { columns, cost } = progressOf(current, plan, counts);
      const last = plan.work?.items.at(-1);
      const moved = last ? { ...cursor, position: last.position, id: last.id } : cursor;
      if (locked.stopping) {
        const cursorOut = withCostMark(moved, cost.unknown);
        return this.stopped(locked, { ...columns, cursor: cursorOut, phase: plan.phase });
      }
      const next = await nextOf(locked, plan, { result: columns.result, moved });
      const cursorOut = withCostMark(next.cursor, cost.unknown);
      // Item que chegou durante a rodada e entrou nela antes de a conferência o contar: `total` nunca fica abaixo de `processed`.
      const total = Math.max(next.total, columns.processed);
      if (next.done) {
        await updateJob(manager, current.id, { ...columns, total, ...doneColumns(cursorOut) });
        return 'committed';
      }
      await updateJob(manager, current.id, {
        ...columns,
        phase: next.phase,
        cursor: cursorOut,
        total,
      });
      await this.publishNext(locked, 0);
      return 'committed';
    });
  }

  /**
   * Falha do provedor: o lote não grava nada nos itens, mas o custo das chamadas já concluídas entra em `costUsd` (a
   * ficha foi conferida: o lote descartado não soma). Terminal ou na última tentativa, o job termina `failed`; senão
   * `batchAttempts` sobe e o mesmo lote é republicado com a espera de 15 s e depois de 60 s.
   */
  commitFailure(
    job: FlyerProJob,
    phase: EnrichPhase,
    failure: BatchFailure,
    usage: AiInvocationUsage | null,
  ): Promise<CommitOutcome> {
    return this.locked(job, async (locked) => {
      const { manager, current } = locked;
      const paid = paidColumns(current, usage);
      if (locked.stopping) return this.stopped(locked, { clearHeartbeat: true, phase, ...paid });
      const attempts = (current.batchAttempts ?? 0) + 1;
      const decision = failureDecision({
        attempts,
        maxAttempts: this.config.maxAttempts,
        terminal: failure.terminal,
      });
      if (decision === 'fail') {
        await updateJob(manager, current.id, {
          ...failedColumns(failure.code, phase, attempts),
          ...paid,
        });
        return 'committed';
      }
      await updateJob(manager, current.id, {
        batchAttempts: attempts,
        clearHeartbeat: true,
        ...paid,
      });
      await this.publishNext(locked, retryDelaySeconds(attempts) ?? 0);
      return 'committed';
    });
  }

  /** Parada pedida (ou encarte excluído) vista ao assumir o lote: fecha `canceled` sem chamar o provedor. */
  cancelClaimed(job: FlyerProJob): Promise<CommitOutcome> {
    return this.locked(job, (locked) => this.stopped(locked, { clearHeartbeat: true }));
  }

  /** Erro que não é do provedor, depois de assumir a ficha: o job termina `failed` com `INTERNAL`. */
  failUnexpected(job: FlyerProJob, phase: EnrichPhase | null): Promise<CommitOutcome> {
    return this.locked(job, async ({ manager, current }) => {
      await updateJob(manager, current.id, failedColumns('INTERNAL', phase, 0));
      return 'committed';
    });
  }

  /** Transação curta: encarte (mesmo excluído), depois a linha do job, e a ficha conferida antes de qualquer escrita. */
  private locked(
    job: FlyerProJob,
    work: (locked: Locked) => Promise<CommitOutcome>,
  ): Promise<CommitOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const document = await findLockedDocument(manager, job.documentId, { withDeleted: true });
      const current = document ? await lockJob(manager, job.id) : null;
      if (!current || current.status !== 'running' || current.batchSeq !== job.batchSeq) {
        return 'discarded';
      }
      const stopping = document.deletedAt != null || current.cancelRequestedAt != null;
      return work({ manager, document, current, stopping });
    });
  }

  private async writeContext(locked: Locked, round: number): Promise<WriteContext> {
    const { manager, current } = locked;
    return {
      stamp: await readStamp(manager),
      jobId: current.id,
      documentId: current.documentId,
      autoApply: current.autoApply,
      onlyMissing: effectiveOnlyMissing(current.onlyMissing, round),
    };
  }

  /** Grava o progresso e fecha o job `canceled`, com a fase em que parou; nenhum lote novo é publicado. */
  private async stopped(
    { manager, current }: Locked,
    progress: JobColumns,
  ): Promise<CommitOutcome> {
    await updateJob(manager, current.id, {
      ...progress,
      ...finalFields('canceled', progress.phase ?? current.phase),
      clearHeartbeat: true,
      finish: true,
    });
    return 'committed';
  }

  /**
   * Publica o próximo lote com a ficha atual, na transação, num savepoint: se a fila falhar, só a publicação é desfeita,
   * os itens do lote ficam gravados e o job termina `failed` com `QUEUE_UNAVAILABLE`.
   */
  private async publishNext(locked: Locked, startAfterSeconds: number): Promise<void> {
    const { manager, current } = locked;
    const published = await inSavepoint(manager, 'flyer_pro_enrich_next', () =>
      publishJobBatch(
        this.queue,
        manager,
        { jobId: current.id, seq: current.batchSeq },
        { expireInSeconds: this.config.batchExpireSeconds, startAfterSeconds },
      ),
    );
    if (published.ok) return;
    this.logger.error(
      `Próximo lote do job ${current.id} não publicado: ${String(published.error)}`,
    );
    await updateJob(manager, current.id, failedColumns('QUEUE_UNAVAILABLE', current.phase, 0));
  }
}
